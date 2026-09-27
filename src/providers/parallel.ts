// Adapted from OMP's Parallel REST/public-MCP search adapter; see NOTICE.
import type { AuthStorage } from "../auth";
import { callMcp, isRecord, jsonRequest, mcpPayloads, text } from "../http";
import { formatQuery, parseSearchQuery } from "../query";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { clampNumResults } from "../utils";
import { SearchProvider, type SearchParams } from "./base";

export class ParallelProvider extends SearchProvider {
  readonly id = "parallel";
  readonly label = "Parallel";
  isAvailable(auth: AuthStorage) { return auth.keys.source(this.id) !== undefined; }
  override isExplicitlyAvailable() { return true; }
  async search(params: SearchParams): Promise<SearchResponse> {
    const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
    const query = parsed.hasDirectives ? formatQuery(parsed, { phrases: true, negation: true, or: true }) : params.query;
    const days = { day: 1, week: 7, month: 30, year: 365 };
    const after = parsed.after ?? (params.recency ? new Date(Date.now() - days[params.recency] * 86400000).toISOString().slice(0, 10) : undefined);
    const key = await params.authStorage.keys.get(this.id, undefined, { signal: params.signal });
    let payload: unknown;
    if (key) {
      const include = parsed.sites.map(site => site.split("/")[0]);
      const exclude = parsed.excludedSites.map(site => site.split("/")[0]);
      payload = await jsonRequest(this.id, "https://api.parallel.ai/v1beta/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "parallel-beta": "search-extract-2025-10-10" },
        body: JSON.stringify({ objective: query, search_queries: [query], mode: "fast", excerpts: { max_chars_per_result: 10000 }, source_policy: {
          ...(include.length ? { include_domains: include } : exclude.length ? { exclude_domains: exclude } : {}),
          ...(after ? { after_date: after } : {}),
        } }), signal: params.signal,
      }, params.fetch);
    } else {
      if (params.authStorage.keys.source(this.id)) throw new SearchProviderError(this.id, "Parallel credentials could not be resolved");
      let mcpQuery = formatQuery(parsed, { phrases: true, negation: true, or: true, site: true, dateRange: true });
      if (!parsed.after && after) mcpQuery += ` after:${after}`;
      // Do not transmit Pi session/model metadata to public search services.
      const result = await callMcp(this.id, "https://search.parallel.ai/mcp", "web_search", { objective: query, search_queries: [mcpQuery] }, params.signal, params.fetch);
      payload = mcpPayloads(result).find(value => isRecord(value) && Array.isArray(value.results));
    }
    if (!isRecord(payload) || !Array.isArray(payload.results)) throw new SearchProviderError(this.id, "Parallel returned an unexpected response shape");
    const sources: SearchSource[] = [];
    for (const row of payload.results) {
      if (!isRecord(row) || !text(row.url)) continue;
      sources.push({ title: text(row.title) ?? String(row.url), url: String(row.url),
        snippet: Array.isArray(row.excerpts) ? row.excerpts.filter(x => typeof x === "string").join("\n") : text(row.snippet),
        publishedDate: text(row.publish_date) ?? text(row.publishedDate),
      });
    }
    return { provider: this.id, sources: sources.slice(0, clampNumResults(params.numSearchResults ?? params.limit, 10, 40)), requestId: text(payload.search_id), authMode: key ? "api_key" : "keyless" };
  }
}

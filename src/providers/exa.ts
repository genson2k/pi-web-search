// Adapted from OMP's Exa REST/public-MCP adapter; see NOTICE.
import type { AuthStorage } from "../auth";
import { callMcp, isRecord, jsonRequest, mcpPayloads, text } from "../http";
import { formatQuery, parseSearchQuery } from "../query";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { clampNumResults } from "../utils";
import { SearchProvider, type SearchParams } from "./base";
import { waitForExaSlot } from "../pacing";

function parseTextResults(value: string): Record<string, unknown>[] {
  return value.replace(/\r\n?/g, "\n").split(/\n{2,}(?=Title:)/).flatMap(section => {
    const field = (label: string) => new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]*)`).exec(section)?.[1]?.trim();
    const url = field("URL");
    return url ? [{ title: field("Title"), url, publishedDate: field("Published Date"), text: /(?:^|\n)Text:\s*([\s\S]*)/.exec(section)?.[1] }] : [];
  });
}
export class ExaProvider extends SearchProvider {
  readonly id = "exa";
  readonly label = "Exa";
  isAvailable(auth: AuthStorage) { return auth.keys.source(this.id) !== undefined; }
  override isExplicitlyAvailable() { return true; }
  async search(params: SearchParams): Promise<SearchResponse> {
    await waitForExaSlot(params.signal);
    const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
    const count = clampNumResults(params.numSearchResults ?? params.limit, 10, 40);
    const key = await params.authStorage.keys.get(this.id, undefined, { signal: params.signal });
    let rows: unknown[] | undefined;
    let requestId: string | undefined;
    if (key) {
      const query = parsed.hasDirectives ? formatQuery(parsed, { phrases: true }) : params.query;
      const payload = await jsonRequest(this.id, "https://api.exa.ai/search", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query, numResults: count, type: "auto", contents: { summary: { query } },
          ...(parsed.sites.length ? { includeDomains: parsed.sites.map(s => s.split("/")[0]) } : {}),
          ...(parsed.excludedSites.length ? { excludeDomains: parsed.excludedSites.map(s => s.split("/")[0]) } : {}),
          ...(parsed.after ? { startPublishedDate: parsed.after } : {}),
          ...(parsed.before ? { endPublishedDate: parsed.before } : {}),
        }), signal: params.signal,
      }, params.fetch);
      if (isRecord(payload)) { rows = Array.isArray(payload.results) ? payload.results : undefined; requestId = text(payload.requestId); }
    } else {
      if (params.authStorage.keys.source(this.id)) throw new SearchProviderError(this.id, "Exa credentials could not be resolved");
      const result = await callMcp(this.id, "https://mcp.exa.ai/mcp?tools=web_search_exa", "web_search_exa", {
        query: formatQuery(parsed, { phrases: true, site: true, dateRange: true }), numResults: count,
      }, params.signal, params.fetch);
      for (const value of mcpPayloads(result)) {
        if (isRecord(value) && Array.isArray(value.results)) { rows = value.results; break; }
        if (typeof value === "string") { const parsedRows = parseTextResults(value); if (parsedRows.length) { rows = parsedRows; break; } }
      }
    }
    if (!rows) throw new SearchProviderError(this.id, "Exa returned an unexpected response shape");
    const sources: SearchSource[] = [];
    const summaries: string[] = [];
    for (const row of rows) {
      if (!isRecord(row) || !text(row.url)) continue;
      const title = text(row.title) ?? String(row.url);
      const summary = text(row.summary);
      sources.push({ title, url: String(row.url), snippet: (summary ?? text(row.text))?.slice(0, 500), publishedDate: text(row.publishedDate), author: text(row.author) });
      if (summary && summaries.length < 3) summaries.push(`**${title}**: ${summary}`);
    }
    return { provider: this.id, sources: sources.slice(0, count), answer: summaries.join("\n\n") || undefined, requestId, authMode: key ? "api_key" : "keyless" };
  }
}

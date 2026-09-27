import type { AuthStorage } from "../auth";
import { isRecord, jsonRequest, text } from "../http";
import { formatQuery, formatScraperQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { SearchProvider, type SearchParams } from "./base";

const recencyDays = { day: 1, week: 7, month: 30, year: 365 };
function sourcesFrom(rows: unknown): SearchSource[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (!isRecord(row)) return [];
    const url = text(row.url) ?? text(row.link) ?? text(row.href);
    return url ? [{ url, title: text(row.title) ?? url, snippet: text(row.snippet) ?? text(row.content) ?? text(row.description), publishedDate: text(row.time) ?? text(row.publishedDate) ?? text(row.published_date) }] : [];
  });
}
export class KagiProvider extends SearchProvider {
  readonly id = "kagi"; readonly label = "Kagi";
  isAvailable(auth: AuthStorage) { return !!auth.keys.source(this.id); }
  async search(p: SearchParams): Promise<SearchResponse> {
    const q = p.parsedQuery ?? parseSearchQuery(p.query);
    const key = await p.authStorage.keys.get(this.id, undefined, { signal: p.signal });
    if (!key) throw new Error("Kagi not configured");
    const after = q.after ?? (p.recency ? new Date(Date.now() - recencyDays[p.recency] * 86400000).toISOString().slice(0, 10) : undefined);
    const payload = await jsonRequest(this.id, "https://kagi.com/api/v1/search", { method: "POST", signal: p.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: formatQuery(q, { ...GOOGLE_QUERY_SYNTAX, dateRange: false }), workflow: "search", limit: p.numSearchResults ?? p.limit ?? 10, filters: { after, before: q.before } }),
    }, p.fetch);
    if (!isRecord(payload) || payload.error || !isRecord(payload.data)) throw new SearchProviderError(this.id, "Invalid provider response");
    const d = payload.data;
    const sources = sourcesFrom(d.search);
    for (const [field, tag] of [["video", "Video"], ["news", "News"], ["infobox", "Info"]]) sources.push(...sourcesFrom(d[field]).map(s => ({ ...s, title: `[${tag}] ${s.title}` })));
    const answerRow = Array.isArray(d.direct_answer) ? d.direct_answer[0] : undefined;
    const relatedQuestions = [d.adjacent_question, d.related_search].flatMap(rows => Array.isArray(rows) ? rows : []).flatMap(row => {
      if (!isRecord(row)) return [];
      const value = isRecord(row.props) ? text(row.props.question) ?? text(row.props.query) : undefined;
      return value ?? text(row.title) ?? [];
    });
    return { provider: this.id, sources, relatedQuestions, answer: isRecord(answerRow) ? text(answerRow.snippet) ?? text(answerRow.title) : undefined, requestId: isRecord(payload.meta) ? text(payload.meta.trace) : undefined };
  }
}
export class FirecrawlProvider extends SearchProvider {
  readonly id = "firecrawl"; readonly label = "Firecrawl";
  isAvailable(auth: AuthStorage) { return !!auth.keys.source(this.id) || !!process.env.FIRECRAWL_BASE_URL || !!process.env.FIRECRAWL_API_URL; }
  override isExplicitlyAvailable() { return true; }
  async search(p: SearchParams): Promise<SearchResponse> {
    const q = p.parsedQuery ?? parseSearchQuery(p.query);
    const key = await p.authStorage.keys.get(this.id, undefined, { signal: p.signal });
    let base = (process.env.FIRECRAWL_BASE_URL ?? process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/+$/, "");
    if (!/\/v2$/.test(base)) base += "/v2";
    const date = (iso: string) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };
    const tbs = q.after || q.before ? ["cdr:1", ...(q.after ? [`cd_min:${date(q.after)}`] : []), ...(q.before ? [`cd_max:${date(q.before)}`] : [])].join(",")
      : p.recency ? `qdr:${{ day: "d", week: "w", month: "m", year: "y" }[p.recency]}` : undefined;
    const payload = await jsonRequest(this.id, `${base}/search`, { method: "POST", signal: p.signal, redirect: "error",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ query: formatQuery(q, { ...GOOGLE_QUERY_SYNTAX, dateRange: false }), limit: p.numSearchResults ?? p.limit ?? 10, sources: [{ type: "web" }], tbs }),
    }, p.fetch);
    if (!isRecord(payload) || payload.success === false) throw new SearchProviderError(this.id, "Invalid provider response");
    return { provider: this.id, sources: sourcesFrom(Array.isArray(payload.data) ? payload.data : isRecord(payload.data) ? payload.data.web : payload.results), authMode: key ? "api_key" : "keyless", requestId: text(payload.id) };
  }
}
export class SearXNGProvider extends SearchProvider {
  readonly id = "searxng"; readonly label = "SearXNG";
  isAvailable() { return !!process.env.SEARXNG_ENDPOINT; }
  async search(p: SearchParams): Promise<SearchResponse> {
    const endpoint = process.env.SEARXNG_ENDPOINT?.replace(/\/+$/, "");
    if (!endpoint) throw new Error("SearXNG not configured");
    const q = p.parsedQuery ?? parseSearchQuery(p.query);
    const url = new URL(`${endpoint}/search`);
    url.searchParams.set("q", formatScraperQuery(p.query, q).split(/\s+/).filter(part => !part.startsWith("!!")).join(" "));
    url.searchParams.set("format", "json");
    if (p.recency) url.searchParams.set("time_range", p.recency === "week" ? "month" : p.recency);
    for (const [name, value] of Object.entries({ categories: process.env.SEARXNG_CATEGORIES, language: q.lang ?? process.env.SEARXNG_LANGUAGE, engines: process.env.SEARXNG_ENGINES, safesearch: process.env.SEARXNG_SAFESEARCH })) if (value) url.searchParams.set(name, value);
    const headers: Record<string, string> = { Accept: "application/json" };
    const user = process.env.SEARXNG_BASIC_USERNAME, password = process.env.SEARXNG_BASIC_PASSWORD;
    if (user !== undefined || password !== undefined) {
      if (user === undefined || password === undefined || user.includes(":") || /[\x00-\x1f\x7f-\x9f]/.test(user + password)) throw new Error("Invalid SearXNG Basic auth configuration");
      headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    } else if (process.env.SEARXNG_TOKEN) headers.Authorization = `Bearer ${process.env.SEARXNG_TOKEN}`;
    if (process.env.SEARXNG_ENGINES) {
      try {
        const config = await jsonRequest(this.id, `${endpoint}/config`, { headers, signal: p.signal, redirect: "error" }, p.fetch);
        if (isRecord(config) && Array.isArray(config.engines)) {
          const entries = config.engines.filter(isRecord);
          url.searchParams.set("engines", process.env.SEARXNG_ENGINES.split(",").map(x => x.trim()).map(x => text(entries.find(e => e.shortcut === x || e.name === x)?.name) ?? x).join(","));
        }
      } catch { p.signal?.throwIfAborted(); }
    }
    const payload = await jsonRequest(this.id, url, { headers, signal: p.signal, redirect: "error" }, p.fetch);
    if (!isRecord(payload)) throw new SearchProviderError(this.id, "Invalid provider response");
    const answer = Array.isArray(payload.answers) ? payload.answers.flatMap(a => typeof a === "string" ? a : isRecord(a) && text(a.answer) ? String(a.answer) : []).slice(0, 3).join("\n\n") : undefined;
    return { provider: this.id, sources: sourcesFrom(payload.results), answer, relatedQuestions: Array.isArray(payload.suggestions) ? payload.suggestions.filter((x): x is string => typeof x === "string") : undefined };
  }
}

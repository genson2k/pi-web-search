import type { AuthStorage } from "../auth";
import { isRecord, jsonRequest, text } from "../http";
import { formatQuery, parseSearchQuery } from "../query";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { SearchProvider, type SearchParams } from "./base";
import { callPerplexityAsk } from "./perplexity-consumer";

export class PerplexityProvider extends SearchProvider {
  readonly id = "perplexity";
  readonly label = "Perplexity";
  isAvailable(auth: AuthStorage) { return !!process.env.PERPLEXITY_COOKIES?.trim() || !!auth.oauth?.has("perplexity") || !!auth.keys.source("perplexity"); }
  override isExplicitlyAvailable() { return true; }
  async search(params: SearchParams): Promise<SearchResponse> {
    const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
    const date = (iso: string) => { const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
    const filters = {
      query: formatQuery(parsed, { phrases: true, negation: true, or: true, inUrl: true, inTitle: true, filetype: true }),
      domainFilter: [...parsed.sites.map(s => s.split("/")[0]), ...parsed.excludedSites.map(s => `-${s.split("/")[0]}`)].slice(0, 20),
      afterDate: parsed.after ? date(parsed.after) : undefined, beforeDate: parsed.before ? date(parsed.before) : undefined,
      languageFilter: parsed.lang ? [parsed.lang.split(/[-_]/)[0]] : undefined,
    };
    const methods: Array<() => Promise<SearchResponse>> = [];
    const consumer = async (auth: Parameters<typeof callPerplexityAsk>[0]): Promise<SearchResponse> => ({
      provider: this.id, ...await callPerplexityAsk(auth, { ...params, search_recency_filter: params.recency, subscription_model: params.model }, filters), authMode: auth.type,
    });
    if (process.env.PERPLEXITY_COOKIES?.trim()) methods.push(() => consumer({ type: "cookies", cookies: process.env.PERPLEXITY_COOKIES!.trim() }));
    if (params.authStorage.oauth?.has("perplexity")) methods.push(async () => {
      const access = await params.authStorage.oauth!.get("perplexity", params.signal);
      if (!access) throw new Error("Perplexity session unavailable. Run /login perplexity");
      return consumer({ type: "oauth", token: access.accessToken });
    });
    const key = await params.authStorage.keys.get("perplexity", undefined, { signal: params.signal });
    if (key) methods.push(() => this.api(params, filters, key, false));
    if (params.explicit) {
      const routerKey = await params.authStorage.keys.get("openrouter", undefined, { signal: params.signal });
      if (routerKey) methods.push(() => this.api(params, filters, routerKey, true));
    }
    if (!methods.length && params.explicit) methods.push(() => consumer({ type: "anonymous" }));
    let last: unknown;
    for (const method of methods) {
      try { return await method(); } catch (error) { params.signal?.throwIfAborted(); last = error; }
    }
    throw last ?? new SearchProviderError(this.id, "Perplexity not configured");
  }
  private async api(params: SearchParams, filters: { query: string; domainFilter: string[]; afterDate?: string; beforeDate?: string; languageFilter?: string[] }, key: string, router: boolean): Promise<SearchResponse> {
    const model = params.model ?? process.env.PI_PERPLEXITY_API_MODEL ?? "sonar-pro";
    const payload = await jsonRequest(this.id, router ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.perplexity.ai/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal: params.signal,
      body: JSON.stringify({ model: router ? `perplexity/${model}` : model, messages: [{ role: "user", content: filters.query }],
        max_tokens: params.maxOutputTokens ?? 8192, temperature: params.temperature ?? 0.2, search_mode: "web",
        num_search_results: params.numSearchResults ?? params.limit ?? 20, return_related_questions: true,
        ...(filters.domainFilter.length ? { search_domain_filter: filters.domainFilter } : {}),
        search_after_date_filter: filters.afterDate, search_before_date_filter: filters.beforeDate,
        search_language_filter: filters.languageFilter, search_recency_filter: !filters.afterDate && !filters.beforeDate ? params.recency : undefined,
      }),
    }, params.fetch);
    if (!isRecord(payload)) throw new SearchProviderError(this.id, "Invalid JSON response");
    const sources: SearchSource[] = [];
    if (Array.isArray(payload.search_results)) for (const row of payload.search_results) {
      if (isRecord(row) && text(row.url)) sources.push({ title: text(row.title) ?? String(row.url), url: String(row.url), snippet: text(row.snippet), publishedDate: text(row.date) });
    }
    if (Array.isArray(payload.citations)) for (const url of payload.citations) if (typeof url === "string" && !sources.some(s => s.url === url)) sources.push({ title: url, url });
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const answer = isRecord(choice) && isRecord(choice.message) ? text(choice.message.content) : undefined;
    const usage = isRecord(payload.usage) ? payload.usage : {};
    return { provider: this.id, answer, sources, model, authMode: router ? "openrouter" : "api_key", requestId: text(payload.id),
      relatedQuestions: Array.isArray(payload.related_questions) ? payload.related_questions.filter((x): x is string => typeof x === "string") : undefined,
      usage: { inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0, totalTokens: Number(usage.total_tokens) || 0 },
    };
  }
}

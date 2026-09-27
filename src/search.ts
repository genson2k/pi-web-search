import { createAuthStorage, type AuthStorage, type FetchImpl } from "./auth";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import { PROVIDERS, type SearchDetails, type SearchProviderId, type SearchResponse, type SearchToolParams } from "./types";
import type { SearchProvider } from "./providers/base";
import { readLimitedText } from "./providers/utils";
import { productionFetches } from "./providers/browser-page";

export interface SearchOptions {
  authStorage?: AuthStorage;
  signal?: AbortSignal;
  fetch?: FetchImpl;
  /** Exact sequential chain. Explicit entries may use keyless transports. */
  providers?: SearchProviderId[];
  timeoutMs?: number;
  models?: Partial<Record<SearchProviderId, string>>;
  exclude?: SearchProviderId[];
  onAttempt?: (provider: SearchProviderId) => void;
}
export async function getProvider(id: SearchProviderId): Promise<SearchProvider> {
  switch (id) {
    case "anthropic": case "gemini": case "codex": case "xai": case "openrouter": return new (await import("./providers/grounded")).GroundedProvider(id);
    case "perplexity": return new (await import("./providers/perplexity")).PerplexityProvider();
    case "kagi": return new (await import("./providers/rest")).KagiProvider();
    case "firecrawl": return new (await import("./providers/rest")).FirecrawlProvider();
    case "searxng": return new (await import("./providers/rest")).SearXNGProvider();
    case "kimi": return new (await import("./providers/kimi")).KimiProvider();
    case "zai": return new (await import("./providers/zai")).ZaiProvider();
    case "startpage": return new (await import("./providers/startpage")).StartpageProvider();
    case "google": return new (await import("./providers/google")).GoogleProvider();
    case "ecosia": return new (await import("./providers/ecosia")).EcosiaProvider();
    case "mojeek": return new (await import("./providers/mojeek")).MojeekProvider();
    case "public": return new (await import("./providers/public")).PublicWebProvider();
    case "parallel": return new (await import("./providers/parallel")).ParallelProvider();
    case "exa": return new (await import("./providers/exa")).ExaProvider();
    case "brave": return new (await import("./providers/brave")).BraveProvider();
    case "tavily": return new (await import("./providers/tavily")).TavilyProvider();
    case "jina": return new (await import("./providers/jina")).JinaProvider();
    case "synthetic": return new (await import("./providers/synthetic")).SyntheticProvider();
    case "ollama": return new (await import("./providers/ollama")).OllamaProvider();
    case "tinyfish": return new (await import("./providers/tinyfish")).TinyFishProvider();
    case "duckduckgo": return new (await import("./providers/duckduckgo")).DuckDuckGoProvider();
    default: throw new Error(`Unknown search provider: ${String(id)}`);
  }
}
export function parseProviderChain(value: string): SearchProviderId[] | undefined {
  if (!value.trim() || value.trim() === "auto") return undefined;
  const ids = value.split(",").map(s => s.trim());
  for (const id of ids) if (!(PROVIDERS as readonly string[]).includes(id)) {
    throw new Error(`Unknown web search provider "${id}". Choose auto or ${PROVIDERS.join(", ")}.`);
  }
  return [...new Set(ids)] as SearchProviderId[];
}
export function parseTimeout(value?: string): number {
  if (value === undefined || value.trim() === "") return 60000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("PI_WEB_SEARCH_TIMEOUT must be positive seconds");
  return Math.ceil(Math.min(seconds, 300) * 1000);
}

/** Race the entire attempt (including credential lookup/body reads) against a
 * deadline. Finally removes listeners/timers even when a transport ignores abort. */
async function withDeadline<T>(parent: AbortSignal | undefined, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const onParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Search provider timed out", "TimeoutError")), ms);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }), aborted]); }
  finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** Enforce byte caps even for upstream adapters that call response.json/text. */
function boundedFetch(provider: SearchProviderId, impl: FetchImpl, signal: AbortSignal): FetchImpl {
  const wrapped: FetchImpl = async (input, init) => {
    signal.throwIfAborted();
    const transportSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const response = await impl(input, { ...init, signal: transportSignal });
    // MCP SSE must remain incremental (some servers keep the stream open).
    if (response.headers.get("content-type")?.includes("text/event-stream")) return response;
    const body = await readLimitedText(response, provider, response.ok ? 2 * 1024 * 1024 : 8192, !response.ok, transportSignal);
    const buffered = new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
    Object.defineProperty(buffered, "url", { value: response.url });
    return buffered;
  };
  if (impl === globalThis.fetch) productionFetches.add(wrapped);
  return wrapped;
}
function safeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}
export function sanitizeResponse(response: SearchResponse): SearchResponse {
  return { ...response, sources: response.sources.filter(source => safeUrl(source.url)),
    citations: response.citations?.filter(citation => safeUrl(citation.url)),
  };
}
export async function runSearchQuery(params: SearchToolParams, options: SearchOptions = {}): Promise<SearchDetails> {
  options.signal?.throwIfAborted();
  if (!params.query?.trim()) throw new Error("Search query must not be empty");
  if (params.query.length > 10000) throw new Error("Search query exceeds 10000 characters");
  for (const value of [params.limit, params.num_search_results]) if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 40)) {
    throw new Error("Search result count must be an integer from 1 to 40");
  }
  if (params.recency !== undefined && !["day", "week", "month", "year"].includes(params.recency)) throw new Error("Invalid search recency");
  if (params.max_tokens !== undefined && (!Number.isInteger(params.max_tokens) || params.max_tokens < 1 || params.max_tokens > 32768)) throw new Error("max_tokens must be an integer from 1 to 32768");
  if (params.temperature !== undefined && (!Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 1)) throw new Error("temperature must be between 0 and 1");
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Search timeout must be positive");
  const auth = options.authStorage ?? createAuthStorage();
  const parsed = parseSearchQuery(params.query);
  const pinned = params.provider && params.provider !== "auto" ? [params.provider] : options.providers;
  const failures: SearchDetails["failures"] = [];
  const candidates = pinned
    ? [...new Set(pinned)].map(id => ({ id, explicit: true }))
    : [
        ...PROVIDERS.filter(id => !["duckduckgo", "startpage", "ecosia", "google", "mojeek", "public"].includes(id)).map(id => ({ id, explicit: false })),
        ...(["parallel", "exa", "startpage", "duckduckgo", "ecosia", "google", "mojeek"] as const).map(id => ({ id, explicit: true })),
      ];
  const attempted = new Set<SearchProviderId>();
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    if (attempted.has(candidate.id) || options.exclude?.includes(candidate.id)) continue;
    const provider = await getProvider(candidate.id);
    try {
      const details = await withDeadline(options.signal, Math.min(Math.ceil(timeoutMs), 300000), async signal => {
        const available = await (candidate.explicit ? provider.isExplicitlyAvailable(auth) : provider.isAvailable(auth));
        signal.throwIfAborted();
        if (!available) {
          if (!candidate.explicit) return undefined;
          throw new Error(`${provider.label} is not configured; set its API key`);
        }
        attempted.add(candidate.id);
        options.onAttempt?.(candidate.id);
        const response = sanitizeResponse(await provider.search({
          query: params.query, parsedQuery: parsed, recency: params.recency,
          limit: params.limit ?? 10, numSearchResults: params.num_search_results,
          signal, timeoutMs, authStorage: auth, fetch: boundedFetch(candidate.id, options.fetch ?? fetch, signal),
          explicit: candidate.explicit, model: params.model ?? options.models?.[candidate.id], maxOutputTokens: params.max_tokens, temperature: params.temperature,
        }));
        signal.throwIfAborted();
        const filtered = applyQueryConstraints(response.sources, parsed);
        response.sources = filtered.sources.slice(0, params.num_search_results ?? params.limit ?? 10);
        if (!response.sources.length && !response.answer?.trim() && !response.citations?.length) throw new Error(`${provider.label} returned no search results`);
        return { response, notes: filtered.dropped.map(label => `no results matched \`${label}\`; the constraint was relaxed`), failures: [...failures] };
      });
      if (details) return details;
    } catch (error) {
      options.signal?.throwIfAborted();
      // Do not echo remote response bodies or credential helper error strings.
      const raw = error instanceof Error ? error.message : "";
      const message = error instanceof DOMException && error.name === "TimeoutError" ? "request timed out"
        : /(?:401|403|402|429)/.test(raw) ? `HTTP ${raw.match(/(?:401|403|402|429)/)?.[0]}`
        : /not configured/.test(raw) ? "API key is not configured"
        : /no search results/.test(raw) ? "no search results"
        : /bot-detection/.test(raw) ? "bot-detection challenge; try a different provider"
        : /exceed/i.test(raw) ? "response exceeds size limit"
        : /unexpected response shape|invalid JSON/.test(raw) ? "invalid provider response"
        : "request failed (network, credentials, or provider response)";
      failures.push({ provider: candidate.id, error: message });
    }
  }
  throw new Error(failures.length ? `All web search providers failed: ${failures.map(f => `${f.provider}: ${f.error}`).join("; ")}` : "No web search providers configured");
}

// OMP-style compact source/citation output; remote text is untrusted data.
export function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
  const short = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const parts = [`Provider: ${response.provider}`, ...notes.map(note => `Note: ${note}`)];
  if (response.answer) parts.push(response.answer);
  if (response.answer && response.sources.length) parts.push("\n## Sources");
  for (const [i, source] of response.sources.entries()) {
    parts.push(`[${i + 1}] ${source.title}${source.publishedDate ? ` (${source.publishedDate})` : ""}\n    ${source.url}`);
    if (source.snippet) parts.push(`    ${short(source.snippet, 240)}`);
  }
  if (response.citations?.length) {
    parts.push("\n## Citations");
    for (const citation of response.citations) parts.push(`${citation.title}\n    ${citation.url}${citation.citedText ? `\n    ${short(citation.citedText, 240)}` : ""}`);
  }
  if (response.relatedQuestions?.length) parts.push("\n## Related", ...response.relatedQuestions.map(q => `- ${q}`));
  if (response.searchQueries?.length) parts.push("Search queries:", ...response.searchQueries.slice(0, 3).map(q => `- ${short(q, 120)}`));
  // Prevent remote terminal control sequences from appearing in tool output.
  return parts.join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

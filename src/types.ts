export const PROVIDERS = ["parallel", "perplexity", "gemini", "anthropic", "codex", "xai", "openrouter", "zai", "exa", "tinyfish", "jina", "kagi", "tavily", "firecrawl", "brave", "kimi", "synthetic", "ollama", "searxng", "startpage", "duckduckgo", "ecosia", "google", "mojeek", "public"] as const;
export type SearchProviderId = typeof PROVIDERS[number];
export const SEARCH_PROVIDER_LABELS: Record<SearchProviderId, string> = {
  perplexity: "Perplexity", gemini: "Gemini", anthropic: "Anthropic", codex: "Codex", xai: "xAI", openrouter: "OpenRouter", zai: "Z.AI",
  kagi: "Kagi", firecrawl: "Firecrawl", kimi: "Kimi", searxng: "SearXNG", startpage: "Startpage", ecosia: "Ecosia", google: "Google", mojeek: "Mojeek", public: "Public Web",
  parallel: "Parallel", exa: "Exa", brave: "Brave", tavily: "Tavily", jina: "Jina",
  synthetic: "Synthetic", ollama: "Ollama", tinyfish: "TinyFish", duckduckgo: "DuckDuckGo",
};
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;
export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  ageSeconds?: number;
  author?: string;
}
export interface SearchResponse {
  provider: SearchProviderId;
  answer?: string;
  sources: SearchSource[];
  citations?: { url: string; title: string; citedText?: string }[];
  relatedQuestions?: string[];
  searchQueries?: string[];
  requestId?: string;
  authMode?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; searchRequests?: number };
}
export interface SearchToolParams {
  query: string;
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
  num_search_results?: number;
  provider?: SearchProviderId | "auto";
  model?: string;
  max_tokens?: number;
  temperature?: number;
}
export interface SearchDetails {
  response: SearchResponse;
  notes: string[];
  failures: { provider: SearchProviderId; error: string }[];
  fullOutputPath?: string;
}
export class SearchProviderError extends Error {
  constructor(public readonly provider: SearchProviderId, message: string, public readonly status?: number) {
    super(message);
    this.name = "SearchProviderError";
  }
}

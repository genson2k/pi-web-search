// Compatibility boundary: Pi owns stored credentials and OAuth refresh.
// Never open a second auth store or borrow another application's credentials.
export type FetchImpl = typeof globalThis.fetch;
export type ApiKey = string | (() => Promise<string | undefined>);
export const KEY_ENV: Record<string, string[]> = {
  perplexity: ["PERPLEXITY_API_KEY"], google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_SEARCH_API_KEY", "ANTHROPIC_API_KEY"], xai: ["XAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY"],
  zai: ["ZAI_API_KEY"], kagi: ["KAGI_API_KEY"], firecrawl: ["FIRECRAWL_API_KEY"],
  "kimi-code": ["MOONSHOT_SEARCH_API_KEY", "KIMI_SEARCH_API_KEY", "KIMI_API_KEY"],
  parallel: ["PARALLEL_API_KEY"], exa: ["EXA_API_KEY"], brave: ["BRAVE_API_KEY"],
  tavily: ["TAVILY_API_KEY"], jina: ["JINA_API_KEY"], synthetic: ["SYNTHETIC_API_KEY"],
  "ollama-cloud": ["OLLAMA_CLOUD_API_KEY"], tinyfish: ["TINYFISH_API_KEY"],
};
export function getEnvApiKey(provider: string): string | undefined {
  return KEY_ENV[provider]?.map(name => process.env[name]?.trim()).find(Boolean);
}
export interface OAuthAccess { accessToken: string; accountId?: string; projectId?: string; headers?: Record<string, string> }
export interface AuthStorage {
  oauth?: { has(provider: string): boolean; get(provider: string, signal?: AbortSignal): Promise<OAuthAccess | undefined> };
  keys: {
    source(provider: string): string | undefined;
    get(provider: string, sessionId?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
    resolver(provider: string, options?: { sessionId?: string }): ApiKey;
  };
}
export function createAuthStorage(options: {
  hasKey?: (provider: string) => boolean;
  getKey?: (provider: string) => Promise<string | undefined>;
  env?: Record<string, string | undefined>;
  oauth?: AuthStorage["oauth"];
} = {}): AuthStorage {
  const envKey = (provider: string) => KEY_ENV[provider]?.map(name => (options.env ?? process.env)[name]?.trim()).find(Boolean);
  const get = async (provider: string, _sessionId?: string, opts?: { signal?: AbortSignal }) => {
    opts?.signal?.throwIfAborted();
    const key = envKey(provider) ?? await options.getKey?.(provider);
    opts?.signal?.throwIfAborted();
    return key?.trim() || undefined;
  };
  return { oauth: options.oauth, keys: {
    source: provider => envKey(provider) ? "environment" : options.hasKey?.(provider) ? "pi" : undefined,
    get,
    resolver: provider => () => get(provider),
  } };
}
export async function withAuth<T>(key: ApiKey, run: (key: string) => Promise<T>, options: {
  signal?: AbortSignal; missingKeyMessage?: string;
} = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const resolved = typeof key === "function" ? await key() : key;
  options.signal?.throwIfAborted();
  if (!resolved) throw new Error(options.missingKeyMessage ?? "Search API key is not configured");
  return run(resolved);
}

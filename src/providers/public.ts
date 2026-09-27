import type { AuthStorage } from "../auth";
import { getProvider } from "../search";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { SearchProvider, type SearchParams } from "./base";

const ENGINES = ["startpage", "google", "duckduckgo", "ecosia", "mojeek"] as const;
export function mergePublicSources(groups: SearchSource[][]): SearchSource[] {
  const merged = new Map<string, { source: SearchSource; engines: number; rank: number; order: number }>();
  for (const group of groups) {
    const seen = new Set<string>();
    for (const [rank, source] of group.entries()) {
      let key = source.url;
      try { const u = new URL(key); key = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`; } catch {}
      if (seen.has(key)) continue;
      seen.add(key);
      const prior = merged.get(key);
      if (!prior) merged.set(key, { source: { ...source }, engines: 1, rank, order: merged.size });
      else {
        prior.engines++;
        if (rank < prior.rank) { prior.rank = rank; prior.source.title = source.title; prior.source.url = source.url; }
        if ((source.snippet?.length ?? 0) > (prior.source.snippet?.length ?? 0)) prior.source.snippet = source.snippet;
        prior.source.publishedDate ??= source.publishedDate;
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.engines - a.engines || a.rank - b.rank || a.order - b.order).map(x => x.source);
}
export class PublicWebProvider extends SearchProvider {
  readonly id = "public"; readonly label = "Public Web";
  isAvailable(_auth: AuthStorage) { return false; }
  override isExplicitlyAvailable() { return true; }
  async search(params: SearchParams): Promise<SearchResponse> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(params.signal ? [params.signal] : [])]);
    const groups: SearchSource[][] = ENGINES.map(() => []);
    const timers: NodeJS.Timeout[] = [];
    let success!: () => void;
    const first = new Promise<void>(resolve => { success = resolve; });
    const delay = (ms: number) => new Promise<void>(resolve => { timers.push(setTimeout(resolve, ms)); });
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
    const all = Promise.all(ENGINES.map(async (id, i) => {
      try { const provider = await getProvider(id); signal.throwIfAborted(); const response = await provider.search({ ...params, signal }); if (!signal.aborted) { groups[i] = response.sources; if (response.sources.length) success(); } }
      catch { /* Engine failures do not discard other engines' results. */ }
    }));
    try {
      signal.throwIfAborted();
      const soft = delay(5000).then(() => first);
      await Promise.race([all, soft, delay(30000), stopped]);
      params.signal?.throwIfAborted();
      const sources = mergePublicSources(groups).slice(0, Math.min(params.numSearchResults ?? params.limit ?? 15, 30));
      if (!sources.length) throw new SearchProviderError(this.id, "All public engines returned no search results");
      return { provider: this.id, sources };
    } finally { signal.removeEventListener("abort", abort); for (const timer of timers) clearTimeout(timer); controller.abort(); }
  }
}

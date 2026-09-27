import { SearchProviderError, type SearchProviderId } from "./types";
/** Bounded incremental SSE JSON parser shared by model-backed search. */
export async function* readSseJson(body: ReadableStream<Uint8Array>, provider: SearchProviderId, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (value) { bytes += value.byteLength; buffer += decoder.decode(value, { stream: true }); }
      if (bytes > 2 * 1024 * 1024) throw new SearchProviderError(provider, "SSE response exceeds 2 MiB");
      if (done) buffer += decoder.decode() + "\n\n";
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") return;
        if (!data) continue;
        const parsed: unknown = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
      }
      if (done) break;
    }
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

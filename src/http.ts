import type { FetchImpl } from "./auth";
import { SearchProviderError, type SearchProviderId } from "./types";
import { classifyProviderHttpError, readLimitedText } from "./providers/utils";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const text = (value: unknown): string | undefined => typeof value === "string" ? value.trim() || undefined : undefined;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function request(provider: SearchProviderId, url: string | URL, init: RequestInit, fetchImpl: FetchImpl = fetch): Promise<Response> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const body = await readLimitedText(response, provider, 8192, true);
    throw classifyProviderHttpError(provider, response.status, body)
      ?? new SearchProviderError(provider, `${provider}: HTTP ${response.status}`, response.status);
  }
  return response;
}
export async function jsonRequest(provider: SearchProviderId, url: string | URL, init: RequestInit, fetchImpl?: FetchImpl): Promise<unknown> {
  const response = await request(provider, url, init, fetchImpl);
  try {
    return JSON.parse(await readLimitedText(response, provider, MAX_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SearchProviderError(provider, `${provider}: invalid JSON response`);
    throw error;
  }
}

/** Stateless public MCP calls, as used by OMP. Handles JSON and incremental SSE.
 * Stops at the matching JSON-RPC response instead of waiting for the server to close. */
export async function callMcp(provider: SearchProviderId, url: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, fetchImpl?: FetchImpl): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const response = await request(provider, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "pi-web-search/0.1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal,
  }, fetchImpl);
  const unwrap = (payload: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(payload) || payload.id !== id) return undefined;
    if (payload.error) throw new SearchProviderError(provider, `${provider}: MCP protocol error`);
    if (!isRecord(payload.result)) throw new SearchProviderError(provider, `${provider}: missing MCP result`);
    if (payload.result.isError) throw new SearchProviderError(provider, `${provider}: MCP tool returned an error`);
    return payload.result;
  };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const result = unwrap(JSON.parse(await readLimitedText(response, provider, MAX_RESPONSE_BYTES)));
    if (result) return result;
  } else if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", bytes = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (value) {
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new SearchProviderError(provider, `${provider}: MCP response exceeds 2 MiB`);
          buffer += decoder.decode(value, { stream: true });
        }
        if (done) buffer += decoder.decode() + "\n\n";
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary) break;
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          const result = unwrap(JSON.parse(data));
          if (result) return result;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  throw new SearchProviderError(provider, `${provider}: no matching MCP response`);
}

export function mcpPayloads(result: Record<string, unknown>): unknown[] {
  const values: unknown[] = [result.structuredContent, result];
  if (Array.isArray(result.content)) for (const block of result.content) {
    if (!isRecord(block) || typeof block.text !== "string") continue;
    try { values.push(JSON.parse(block.text)); } catch { values.push(block.text); }
  }
  return values;
}

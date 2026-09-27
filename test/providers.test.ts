import { expect, it } from "vitest";
import { createAuthStorage } from "../src/auth";
import { runSearchQuery } from "../src/search";
import type { SearchProviderId } from "../src/types";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const emptyAuth = createAuthStorage({ env: {} });

it("reads Parallel public MCP structured results and sends no session metadata", async () => {
  const result = await runSearchQuery({ query: "docs site:example.com", provider: "parallel" }, {
    authStorage: emptyAuth, fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body));
      expect(rpc.params.name).toBe("web_search");
      expect(rpc.params.arguments.search_queries[0]).toContain("site:example.com");
      expect(rpc.params.arguments.session_id).toBeUndefined();
      return json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { results: [{ title: "Docs", url: "https://example.com", excerpts: ["one", "two"] }] } } });
    },
  });
  expect(result.response.sources[0]?.snippet).toBe("one\ntwo");
  expect(result.response.authMode).toBe("keyless");
});

it("reads fragmented SSE without waiting for stream closure", async () => {
  let cancelled = false;
  const result = await runSearchQuery({ query: "docs", provider: "exa" }, {
    authStorage: emptyAuth, timeoutMs: 200,
    fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body));
      const event = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "Title: Docs\nURL: https://example.com\nText: hello" }] } })}\r\n\r\n`;
      const bytes = new TextEncoder().encode(event);
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        // Intentionally remains open.
      }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  expect(result.response.sources[0]?.title).toBe("Docs");
  expect(cancelled).toBe(true);
});

it("rejects MCP tool errors", async () => {
  await expect(runSearchQuery({ query: "x", provider: "exa" }, {
    authStorage: emptyAuth, fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body));
      return json({ id: rpc.id, result: { isError: true, content: [{ type: "text", text: "private server error" }] } });
    },
  })).rejects.toThrow("All web search providers failed");
});

it("maps Exa REST domain and date filters", async () => {
  const result = await runSearchQuery({ query: "docs site:example.com/path after:2024 before:2025", provider: "exa" }, {
    authStorage: createAuthStorage({ env: { EXA_API_KEY: "test" } }),
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.includeDomains).toEqual(["example.com"]);
      expect(body.startPublishedDate).toBe("2024-01-01");
      expect(body.endPublishedDate).toBe("2025-01-01");
      return json({ results: [{ title: "Docs", url: "https://example.com/path", summary: "Summary" }] });
    },
  });
  expect(result.response.answer).toContain("Summary");
});

it("parses DDG HTML redirect links and rejects challenges", async () => {
  const result = await runSearchQuery({ query: "docs", provider: "duckduckgo", recency: "week" }, {
    authStorage: emptyAuth, fetch: async (_input, init) => {
      expect(new URLSearchParams(String(init?.body)).get("df")).toBe("w");
      return new Response('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Docs &amp; API</a><a class="result__snippet">Snippet</a></div>');
    },
  });
  expect(result.response.sources[0]?.url).toBe("https://example.com");
  expect(result.response.sources[0]?.title).toBe("Docs & API");
  await expect(runSearchQuery({ query: "x", provider: "duckduckgo" }, { fetch: async () => new Response("anomaly-modal") })).rejects.toThrow("bot-detection");
});

it.each([
  ["jina", "JINA_API_KEY", { code: 200, data: [{ title: "Docs", url: "https://example.com", description: "snippet" }] }],
  ["synthetic", "SYNTHETIC_API_KEY", { results: [{ title: "Docs", url: "https://example.com", text: "snippet" }] }],
  ["ollama", "OLLAMA_CLOUD_API_KEY", { results: [{ title: "Docs", url: "https://example.com", content: "snippet" }] }],
  ["tinyfish", "TINYFISH_API_KEY", { results: [{ title: "Docs", url: "https://example.com", snippet: "snippet" }] }],
] as const)("adapts %s result envelopes", async (provider, envName, payload) => {
  const result = await runSearchQuery({ query: "docs", provider: provider as SearchProviderId }, {
    authStorage: createAuthStorage({ env: { [envName]: "test" } }), fetch: async () => json(payload),
  });
  expect(result.response.sources[0]?.snippet).toBe("snippet");
});

it("prefers explicit environment keys to an injected Pi key resolver", async () => {
  const auth = createAuthStorage({ env: { BRAVE_API_KEY: "env-key" }, getKey: async () => { throw new Error("must not resolve"); } });
  expect(await auth.keys.get("brave")).toBe("env-key");
});

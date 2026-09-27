import { describe, expect, it } from "vitest";
import { createAuthStorage } from "../src/auth";
import { formatForLLM, parseProviderChain, parseTimeout, runSearchQuery } from "../src/search";

const authStorage = createAuthStorage({ env: { BRAVE_API_KEY: "test-brave", TAVILY_API_KEY: "test-tavily" } });
const braveResult = { web: { results: [{ title: "Docs", url: "https://example.com/docs", description: "Snippet" }] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("search pipeline", () => {
  it("maps Brave operators and result count", async () => {
    const result = await runSearchQuery({ query: "docs site:example.com after:2024", limit: 2 }, {
      providers: ["brave"], authStorage,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("count")).toBe("2");
        expect(url.searchParams.get("freshness")).toMatch(/^2024-01-01to/);
        expect(url.searchParams.get("q")).toBe("docs site:example.com");
        expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("test-brave");
        return json(braveResult);
      },
    });
    expect(result.response.sources).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });
  it("falls back after HTTP failures without leaking response secrets", async () => {
    const attempts: string[] = [];
    const result = await runSearchQuery({ query: "docs", recency: "week" }, {
      providers: ["brave", "tavily"], authStorage, onAttempt: id => attempts.push(id),
      fetch: async (input, init) => {
        if (String(input).includes("brave")) return new Response("SECRET_KEY", { status: 401 });
        const body = JSON.parse(String(init?.body));
        expect(body.time_range).toBe("week");
        expect(body.topic).toBeUndefined();
        return json({ results: [{ title: "Docs", url: "https://example.com", content: "text" }] });
      },
    });
    expect(attempts).toEqual(["brave", "tavily"]);
    expect(result.response.provider).toBe("tavily");
    expect(JSON.stringify(result)).not.toContain("SECRET_KEY");
  });
  it("falls back on empty results and reports relaxed constraints", async () => {
    const result = await runSearchQuery({ query: "docs site:missing.example" }, {
      providers: ["tavily", "brave"], authStorage,
      fetch: async input => json(String(input).includes("tavily") ? { results: [] } : braveResult),
    });
    expect(result.response.provider).toBe("brave");
    expect(result.notes[0]).toContain("constraint was relaxed");
    expect(result.failures).toHaveLength(1);
  });
  it("times out even if a transport ignores abort", async () => {
    const result = await runSearchQuery({ query: "docs" }, {
      providers: ["tavily", "brave"], authStorage, timeoutMs: 20,
      fetch: async input => String(input).includes("tavily") ? new Promise<Response>(() => {}) : json(braveResult),
    });
    expect(result.failures[0]?.error).toBe("request timed out");
    expect(result.response.provider).toBe("brave");
  });
  it("propagates cancellation and does not fall through", async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    const promise = runSearchQuery({ query: "docs" }, {
      providers: ["tavily", "brave"], authStorage, signal: controller.signal,
      onAttempt: id => attempts.push(id),
      fetch: async () => { controller.abort(new Error("user cancelled")); return new Promise<Response>(() => {}); },
    });
    await expect(promise).rejects.toThrow("user cancelled");
    expect(attempts).toEqual(["tavily"]);
  });
  it("rejects pre-aborted calls without network", async () => {
    await expect(runSearchQuery({ query: "x" }, { signal: AbortSignal.abort(new Error("stop")), fetch: async () => { throw new Error("should not run"); } })).rejects.toThrow("stop");
  });
  it("rejects oversized responses", async () => {
    await expect(runSearchQuery({ query: "x", provider: "brave" }, { authStorage, fetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)) })).rejects.toThrow("exceed");
  });
  it("removes non-HTTP result URLs", async () => {
    const result = await runSearchQuery({ query: "x", provider: "tavily" }, {
      authStorage, fetch: async () => json({ results: [{ url: "javascript:alert(1)" }, { url: "https://example.com", title: "ok" }] }),
    });
    expect(result.response.sources).toHaveLength(1);
  });
  it("pins a provider without automatic fallback", async () => {
    let calls = 0;
    await expect(runSearchQuery({ query: "x", provider: "brave" }, { authStorage, fetch: async () => { calls++; return json({}, 500); } })).rejects.toThrow("All web search providers failed");
    expect(calls).toBe(1);
  });
  it("tries configured providers before keyless services", async () => {
    const result = await runSearchQuery({ query: "x" }, { authStorage, fetch: async input => {
      expect(String(input)).toContain("brave"); return json(braveResult);
    } });
    expect(result.response.provider).toBe("brave");
  });
  it("validates parameters/configuration", async () => {
    expect(parseProviderChain("exa,brave,exa")).toEqual(["exa", "brave"]);
    expect(parseProviderChain("auto")).toBeUndefined();
    expect(() => parseProviderChain("typo")).toThrow("Unknown");
    expect(parseTimeout("999")).toBe(300000);
    expect(() => parseTimeout("NaN")).toThrow();
    await expect(runSearchQuery({ query: " " })).rejects.toThrow("empty");
    await expect(runSearchQuery({ query: "x", limit: -1 })).rejects.toThrow("integer");
  });
  it("formats sources with bounded snippets and removes control characters", () => {
    const output = formatForLLM({ provider: "exa", answer: "Answer\u001b", sources: [{ title: "Docs", url: "https://example.com", snippet: "z".repeat(1000) }] }, ["warning"]);
    expect(output).toContain("## Sources");
    expect(output).toContain("Note: warning");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("z".repeat(241));
  });
});

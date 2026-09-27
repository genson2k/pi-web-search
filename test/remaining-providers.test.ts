import { afterEach, expect, it, vi } from "vitest";
import { createAuthStorage } from "../src/auth";
import { getProvider, runSearchQuery } from "../src/search";
import { PROVIDERS } from "../src/types";
import { mergePublicSources } from "../src/providers/public";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const sse = (...events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const source = { title: "Docs", url: "https://example.com/docs" };
const auth = createAuthStorage({ env: { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", XAI_API_KEY: "x", OPENROUTER_API_KEY: "o", KAGI_API_KEY: "k", FIRECRAWL_API_KEY: "f", KIMI_SEARCH_API_KEY: "m", ZAI_API_KEY: "z", PERPLEXITY_API_KEY: "p" } });
afterEach(() => { vi.unstubAllEnvs(); });
it("every advertised OMP provider loads", async () => {
  expect(PROVIDERS).toHaveLength(25);
  for (const id of PROVIDERS) expect((await getProvider(id)).id).toBe(id);
});
it("Perplexity API maps native filters and citations", async () => {
  const result = await runSearchQuery({ query: "docs site:example.com after:2025", provider: "perplexity", max_tokens: 1000 }, { authStorage: auth, fetch: async (input, init) => {
    expect(String(input)).toBe("https://api.perplexity.ai/chat/completions");
    const body = JSON.parse(String(init?.body)); expect(body.search_domain_filter).toEqual(["example.com"]); expect(body.search_after_date_filter).toBe("1/1/2025"); expect(body.max_tokens).toBe(1000);
    return json({ choices: [{ message: { content: "Answer" } }], citations: [source.url], search_results: [source], usage: { prompt_tokens: 10, completion_tokens: 20 } });
  } });
  expect(result.response.sources[0]?.title).toBe("Docs"); expect(result.response.usage?.inputTokens).toBe(10);
});
it("Perplexity subscription sends session cookie, merges chunk offsets, never sends bearer", async () => {
  const sessionAuth = createAuthStorage({ env: {}, oauth: { has: id => id === "perplexity", get: async () => ({ accessToken: "session" }) } });
  const result = await runSearchQuery({ query: "docs", provider: "perplexity" }, { authStorage: sessionAuth, fetch: async (_input, init) => {
    const headers = new Headers(init?.headers); expect(headers.get("Cookie")).toBe("__Secure-next-auth.session-token=session"); expect(headers.has("Authorization")).toBe(false);
    const body = JSON.parse(String(init?.body)); expect(body.params.always_search_override).toBe(true); expect(body.params.skip_search_enabled).toBe(false);
    return sse({ blocks: [{ intended_usage: "markdown", markdown_block: { chunks: ["Hello "] } }] },
      { blocks: [{ intended_usage: "markdown", markdown_block: { chunks: ["world"], chunk_starting_offset: 1 } }, { intended_usage: "web_results", web_result_block: { web_results: [{ name: "Docs", url: source.url }] } }], final: true });
  } });
  expect(result.response.answer).toBe("Hello world"); expect(result.response.sources).toHaveLength(1); expect(result.response.authMode).toBe("oauth");
});
it("Anthropic uses hosted search and parses citations/usage", async () => {
  const result = await runSearchQuery({ query: "docs site:example.com", provider: "anthropic" }, { authStorage: auth, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)); expect(body.tools[0].allowed_domains).toEqual(["example.com"]);
    return json({ content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", ...source }] }, { type: "text", text: "Answer", citations: [{ ...source, cited_text: "quote" }] }], usage: { input_tokens: 3, output_tokens: 4 } });
  } });
  expect(result.response.citations?.[0]?.citedText).toBe("quote");
});
it("Gemini parses SSE grounding metadata", async () => {
  const result = await runSearchQuery({ query: "docs", provider: "gemini" }, { authStorage: auth, fetch: async (input, init) => {
    expect(String(input)).toContain("generativelanguage.googleapis.com"); expect(JSON.parse(String(init?.body)).tools).toEqual([{ googleSearch: {} }]);
    return sse({ candidates: [{ content: { parts: [{ text: "Answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: source.url, title: source.title } }], webSearchQueries: ["docs"] } }], usageMetadata: { promptTokenCount: 3 } });
  } });
  expect(result.response.sources[0]?.url).toBe(source.url); expect(result.response.searchQueries).toEqual(["docs"]);
});
it("Gemini OAuth uses the Cloud Code project envelope", async () => {
  const oauth = createAuthStorage({ env: {}, oauth: { has: id => id === "google-gemini-cli", get: async () => ({ accessToken: "session", projectId: "project" }) } });
  const result = await runSearchQuery({ query: "docs", provider: "gemini" }, { authStorage: oauth, fetch: async (input, init) => {
    expect(String(input)).toContain("cloudcode-pa.googleapis.com"); expect(JSON.parse(String(init?.body)).project).toBe("project");
    return sse({ response: { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: source.url, title: source.title } }] } }] } });
  } }); expect(result.response.sources).toHaveLength(1);
});
it.each(["codex", "xai"] as const)("%s requires a completed hosted web search", async provider => {
  const oauth = createAuthStorage({ env: {}, oauth: { has: () => true, get: async () => ({ accessToken: "session", accountId: "account" }) } });
  const result = await runSearchQuery({ query: "docs", provider }, { authStorage: oauth, fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)); expect(body.tools[0].type).toBe("web_search");
    return sse({ type: "response.completed", response: { output: [{ type: "web_search_call", action: { sources: [source] } }, { type: "message", content: [{ type: "output_text", text: "Answer" }] }] } });
  } }); expect(result.response.answer).toBe("Answer"); expect(result.response.sources).toHaveLength(1);
  await expect(runSearchQuery({ query: "x", provider }, { authStorage: oauth, fetch: async () => sse({ type: "response.completed", response: { output: [] } }) })).rejects.toThrow("failed");
});
it("OpenRouter enables the web plugin and parses annotations", async () => {
  const result = await runSearchQuery({ query: "docs", provider: "openrouter" }, { authStorage: auth, fetch: async (_input, init) => {
    expect(JSON.parse(String(init?.body)).plugins[0].id).toBe("web"); return json({ choices: [{ message: { content: "Answer", annotations: [{ type: "url_citation", url_citation: source }] } }] });
  } }); expect(result.response.sources).toHaveLength(1);
});
it("Kagi parses categorized sources", async () => {
  const result = await runSearchQuery({ query: "docs", provider: "kagi", recency: "week" }, { authStorage: auth, fetch: async (_input, init) => {
    expect(JSON.parse(String(init?.body)).filters.after).toMatch(/^\d{4}-/); return json({ data: { search: [source], news: [{ ...source, url: "https://example.com/news" }], direct_answer: [{ snippet: "Answer" }] } });
  } }); expect(result.response.sources[1]?.title).toBe("[News] Docs"); expect(result.response.answer).toBe("Answer");
});
it("Firecrawl maps dates to tbs", async () => {
  const result = await runSearchQuery({ query: "docs after:2025", provider: "firecrawl" }, { authStorage: auth, fetch: async (_input, init) => {
    expect(JSON.parse(String(init?.body)).tbs).toBe("cdr:1,cd_min:01/01/2025"); return json({ success: true, data: { web: [source] } });
  } }); expect(result.response.sources).toHaveLength(1);
});
it("Kimi uses coding service credentials", async () => {
  const result = await runSearchQuery({ query: "docs", provider: "kimi" }, { authStorage: auth, fetch: async (input, init) => {
    expect(String(input)).toBe("https://api.kimi.com/coding/v1/search"); expect(JSON.parse(String(init?.body)).text_query).toBe("docs"); return json({ search_results: [source] });
  } }); expect(result.response.sources).toHaveLength(1);
});
it("Z.AI performs MCP initialization and parses tool results", async () => {
  const methods: string[] = [];
  const result = await runSearchQuery({ query: "docs", provider: "zai" }, { authStorage: auth, fetch: async (_input, init) => {
    const rpc = JSON.parse(String(init?.body)); methods.push(rpc.method);
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json({ id: rpc.id, result: rpc.method === "initialize" ? { protocolVersion: "2025-03-26" } : { structuredContent: { search_result: [source] } } });
  } }); expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]); expect(result.response.sources).toHaveLength(1);
});
it("SearXNG applies basic auth, native language and week-to-month", async () => {
  vi.stubEnv("SEARXNG_ENDPOINT", "https://search.example.com"); vi.stubEnv("SEARXNG_BASIC_USERNAME", "user"); vi.stubEnv("SEARXNG_BASIC_PASSWORD", "pass");
  const result = await runSearchQuery({ query: "docs lang:vi", provider: "searxng", recency: "week" }, { fetch: async (input, init) => {
    const url = new URL(String(input)); expect(url.searchParams.get("time_range")).toBe("month"); expect(url.searchParams.get("language")).toBe("vi"); expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`); return json({ results: [source], suggestions: ["more"] });
  } }); expect(result.response.relatedQuestions).toEqual(["more"]);
});
it.each([
  ["google", '<div class="MjjYud"><a href="https://example.com/docs"><h3>Docs</h3></a><div class="VwiC3b">Snippet</div></div>'],
  ["ecosia", '<article data-test-id="organic-result"><a href="https://example.com/docs"><h2 data-test-id="result-title">Docs</h2></a><p data-test-id="web-result-description">Snippet</p></article>'],
  ["mojeek", '<ul class="results-standard"><li><h2><a class="title" href="https://example.com/docs">Docs</a></h2><p class="s">Snippet</p></li></ul>'],
  ["startpage", '<div class="result"><a class="result-link" href="https://example.com/docs"><h2>Docs</h2></a><p class="description">Snippet</p></div>'],
] as const)("parses %s organic HTML without launching browser in tests", async (provider, html) => {
  const result = await runSearchQuery({ query: "docs", provider }, { fetch: async () => new Response(html) });
  expect(result.response.sources[0]?.snippet).toBe("Snippet");
});
it("public merging ranks cross-engine consensus, not duplicate rows", () => {
  const unique = { title: "Unique", url: "https://unique.example" };
  const merged = mergePublicSources([[unique, unique, source], [source]]);
  expect(merged[0]?.url).toBe(source.url);
});

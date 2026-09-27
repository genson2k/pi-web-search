// Native search request shapes adapted from OMP; auth/refresh owned by Pi.
import type { AuthStorage, OAuthAccess } from "../auth";
import { isRecord, jsonRequest, request, text } from "../http";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { readSseJson } from "../sse";
import { SearchProviderError, type SearchResponse, type SearchSource } from "../types";
import { SearchProvider, type SearchParams } from "./base";

type GroundedId = "anthropic" | "gemini" | "codex" | "xai" | "openrouter";
const AUTH_IDS: Record<GroundedId, string[]> = { anthropic: ["anthropic"], gemini: ["google", "google-gemini-cli", "google-antigravity"], codex: ["openai-codex"], xai: ["xai", "xai-oauth"], openrouter: ["openrouter"] };
const DEFAULT_MODELS: Record<GroundedId, string> = { anthropic: "claude-haiku-4-5", gemini: "gemini-2.5-flash", codex: "gpt-5.5", xai: "grok-4.5", openrouter: "openai/gpt-4.1-mini" };
const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];
const usage = (value: unknown): SearchResponse["usage"] => {
  const u = isRecord(value) ? value : {};
  return { inputTokens: Number(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount) || 0,
    outputTokens: Number(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount) || 0,
    totalTokens: Number(u.total_tokens ?? u.totalTokenCount) || 0,
    searchRequests: isRecord(u.server_tool_use) ? Number(u.server_tool_use.web_search_requests) || 0 : undefined };
};
function add(sources: SearchSource[], value: Record<string, unknown>) {
  const url = text(value.url) ?? text(value.uri) ?? text(value.source_website_url);
  if (url && !sources.some(s => s.url === url)) sources.push({ url, title: text(value.title) ?? text(value.caption) ?? url, snippet: text(value.snippet) ?? text(value.cited_text), publishedDate: text(value.page_age) });
}
export class GroundedProvider extends SearchProvider {
  readonly label: string;
  constructor(readonly id: GroundedId) { super(); this.label = id; }
  isAvailable(auth: AuthStorage) { return AUTH_IDS[this.id].some(id => !!auth.keys.source(id) || !!auth.oauth?.has(id)); }
  async search(p: SearchParams): Promise<SearchResponse> {
    let model = p.model ?? process.env[`PI_WEB_SEARCH_${this.id.toUpperCase()}_MODEL`] ?? DEFAULT_MODELS[this.id];
    const explicitAuth = AUTH_IDS[this.id].find(id => model.startsWith(`${id}/`));
    if (explicitAuth) model = model.slice(explicitAuth.length + 1);
    const authIds = explicitAuth ? [explicitAuth] : AUTH_IDS[this.id];
    let lastError: unknown;
    for (const authId of authIds) {
      const key = await p.authStorage.keys.get(authId, undefined, { signal: p.signal });
      const oauth = !key && p.authStorage.oauth?.has(authId) ? await p.authStorage.oauth.get(authId, p.signal) : undefined;
      if (!key && !oauth) continue;
      if (this.id === "gemini") {
        try { return await this.gemini(p, model, authId, key, oauth); }
        catch (error) { p.signal?.throwIfAborted(); lastError = error; continue; }
      }
      if (this.id === "anthropic") return this.anthropic(p, model, key, oauth);
      if (this.id === "openrouter") return this.openrouter(p, model, key ?? oauth!.accessToken);
      return this.responses(p, model, key, oauth);
    }
    throw lastError ?? new Error(`${this.label} not configured`);
  }
  private async anthropic(p: SearchParams, model: string, key?: string, oauth?: OAuthAccess): Promise<SearchResponse> {
    const q = p.parsedQuery ?? parseSearchQuery(p.query);
    const hosts = (values: string[]) => [...new Set(values.map(s => s.split("/")[0]))];
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...(oauth?.headers ?? {}) };
    if (key) headers["x-api-key"] = key;
    else {
      headers.Authorization = `Bearer ${oauth!.accessToken}`;
      headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
      headers["x-app"] = "cli";
      headers["User-Agent"] = "claude-cli/2.1.62";
    }
    const payload = await jsonRequest(this.id, "https://api.anthropic.com/v1/messages", { method: "POST", headers, signal: p.signal,
      body: JSON.stringify({ model, max_tokens: p.maxOutputTokens ?? 4096,
        ...(oauth ? { system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] } : {}),
        messages: [{ role: "user", content: formatQuery(q, { ...GOOGLE_QUERY_SYNTAX, site: false }) }],
        tools: [{ type: "web_search_20250305", name: "web_search", ...(q.sites.length ? { allowed_domains: hosts(q.sites) } : q.excludedSites.length ? { blocked_domains: hosts(q.excludedSites) } : {}) }],
        // Recent Anthropic models reject sampling fields; omit universally.
      }),
    }, p.fetch);
    if (!isRecord(payload)) throw new SearchProviderError(this.id, "Invalid provider response");
    const sources: SearchSource[] = [], citations: NonNullable<SearchResponse["citations"]> = [], answers: string[] = [], searchQueries: string[] = [];
    let searched = false;
    for (const block of records(payload.content)) {
      if (block.type === "server_tool_use" && isRecord(block.input) && text(block.input.query)) searchQueries.push(String(block.input.query));
      if (block.type === "web_search_tool_result") {
        searched = true;
        if (isRecord(block.content) && block.content.type === "web_search_tool_result_error") throw new SearchProviderError(this.id, "Hosted web search failed");
        for (const row of records(block.content)) if (row.type === "web_search_result") add(sources, row);
      }
      if (block.type === "text" && text(block.text)) {
        answers.push(String(block.text));
        for (const citation of records(block.citations)) if (text(citation.url)) {
          add(sources, citation);
          citations.push({ url: String(citation.url), title: text(citation.title) ?? String(citation.url), citedText: text(citation.cited_text) });
        }
      }
    }
    if (!searched && !sources.length) throw new SearchProviderError(this.id, "Model did not run web search");
    return { provider: this.id, model, answer: answers.join("\n\n"), sources, citations, searchQueries, usage: usage(payload.usage), requestId: text(payload.id) };
  }
  private async gemini(p: SearchParams, model: string, authId: string, key?: string, oauth?: OAuthAccess): Promise<SearchResponse> {
    const content = { contents: [{ role: "user", parts: [{ text: formatQuery(p.parsedQuery ?? parseSearchQuery(p.query), GOOGLE_QUERY_SYNTAX) }] }],
      tools: [{ googleSearch: {} }], generationConfig: { maxOutputTokens: p.maxOutputTokens ?? 4096, ...(p.temperature !== undefined ? { temperature: p.temperature } : {}) } };
    const isAntigravity = authId === "google-antigravity";
    const endpoint = key ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      : `${isAntigravity ? "https://daily-cloudcode-pa.sandbox.googleapis.com" : "https://cloudcode-pa.googleapis.com"}/v1internal:streamGenerateContent?alt=sse`;
    if (!key && !oauth?.projectId) throw new Error("Gemini OAuth project unavailable; login again");
    const response = await request(this.id, endpoint, { method: "POST", signal: p.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(key ? { "x-goog-api-key": key } : { ...oauth?.headers, Authorization: `Bearer ${oauth!.accessToken}`, "User-Agent": isAntigravity ? "antigravity/1.20.5" : "GeminiCLI/0.31.0", "X-Goog-Api-Client": "gl-node/22.0.0" }) },
      body: JSON.stringify(key ? content : { project: oauth!.projectId, model, request: content, userAgent: isAntigravity ? "antigravity" : "pi-web-search", requestId: `agent-${crypto.randomUUID()}`, ...(isAntigravity ? { requestType: "agent" } : {}) }),
    }, p.fetch);
    if (!response.body) throw new Error("Missing Gemini response body");
    const sources: SearchSource[] = [], answers: string[] = [], queries = new Set<string>();
    let tokens: SearchResponse["usage"];
    for await (const event of readSseJson(response.body, this.id, p.signal)) {
      const data = isRecord(event.response) ? event.response : event;
      if (data.error) throw new SearchProviderError(this.id, "Gemini stream failed");
      for (const candidate of records(data.candidates)) {
        if (isRecord(candidate.content)) for (const part of records(candidate.content.parts)) if (text(part.text) && !part.thought) answers.push(String(part.text));
        if (isRecord(candidate.groundingMetadata)) {
          for (const chunk of records(candidate.groundingMetadata.groundingChunks)) if (isRecord(chunk.web)) add(sources, chunk.web);
          if (Array.isArray(candidate.groundingMetadata.webSearchQueries)) for (const query of candidate.groundingMetadata.webSearchQueries) if (typeof query === "string") queries.add(query);
        }
      }
      if (data.usageMetadata) tokens = usage(data.usageMetadata);
    }
    if (!sources.length && !queries.size) throw new SearchProviderError(this.id, "Model did not run grounded search");
    return { provider: this.id, model, answer: answers.join(""), sources, searchQueries: [...queries], usage: tokens };
  }
  private async openrouter(p: SearchParams, model: string, key: string): Promise<SearchResponse> {
    const payload = await jsonRequest(this.id, "https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: p.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, plugins: [{ id: "web", max_results: p.numSearchResults ?? p.limit ?? 10 }], messages: [{ role: "user", content: p.query }], max_tokens: p.maxOutputTokens, temperature: p.temperature }),
    }, p.fetch);
    if (!isRecord(payload)) throw new SearchProviderError(this.id, "Invalid provider response");
    const sources: SearchSource[] = [], answers: string[] = [];
    for (const choice of records(payload.choices)) if (isRecord(choice.message)) {
      if (text(choice.message.content)) answers.push(String(choice.message.content));
      for (const annotation of records(choice.message.annotations)) if (isRecord(annotation.url_citation)) add(sources, annotation.url_citation);
    }
    return { provider: this.id, model, answer: answers.join("\n"), sources, usage: usage(payload.usage), requestId: text(payload.id) };
  }
  private async responses(p: SearchParams, model: string, key?: string, oauth?: OAuthAccess): Promise<SearchResponse> {
    const codex = this.id === "codex";
    const q = p.parsedQuery ?? parseSearchQuery(p.query);
    const tool: Record<string, unknown> = { type: "web_search" };
    if (codex) tool.search_context_size = "high";
    else if (q.sites.length) tool.filters = { allowed_domains: q.sites.slice(0, 5).map(s => s.split("/")[0]) };
    else if (q.excludedSites.length) tool.filters = { excluded_domains: q.excludedSites.slice(0, 5).map(s => s.split("/")[0]) };
    const headers: Record<string, string> = { ...oauth?.headers, "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key ?? oauth!.accessToken}` };
    if (codex) {
      headers["OpenAI-Beta"] = "responses=experimental"; headers.originator = "codex_cli_rs";
      if (oauth?.accountId) headers["ChatGPT-Account-Id"] = oauth.accountId;
    }
    const response = await request(this.id, codex ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.x.ai/v1/responses", {
      method: "POST", headers, signal: p.signal, body: JSON.stringify({ model, stream: true, store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: formatQuery(q, GOOGLE_QUERY_SYNTAX) }] }],
        tools: [tool], tool_choice: { type: "web_search" }, include: ["web_search_call.action.sources"],
        ...(codex ? { instructions: "Search the web for the user's query and cite your sources." } : { reasoning: { effort: "low" }, max_output_tokens: p.maxOutputTokens, temperature: p.temperature }),
      }),
    }, p.fetch);
    if (!response.body) throw new Error("Missing Responses body");
    const sources: SearchSource[] = [], answers: string[] = [], deltas: string[] = [];
    let searched = false, completed = false;
    let tokens: SearchResponse["usage"], requestId: string | undefined;
    const collect = (item: Record<string, unknown>) => {
      if (item.type === "web_search_call") {
        searched = true;
        for (const rows of [isRecord(item.action) ? item.action.sources : undefined, item.sources, item.results]) for (const source of records(rows)) add(sources, source);
      }
      if (item.type === "message") for (const part of records(item.content)) {
        if (part.type === "output_text" && text(part.text)) answers.push(String(part.text));
        for (const annotation of records(part.annotations)) if (annotation.type === "url_citation") add(sources, annotation);
      }
    };
    for await (const event of readSseJson(response.body, this.id, p.signal)) {
      const type = text(event.type) ?? "";
      if (type === "error" || type === "response.failed" || type === "response.incomplete") throw new SearchProviderError(this.id, "Search stream failed");
      if (type.startsWith("response.web_search_call")) searched = true;
      if (type === "response.output_text.delta" && typeof event.delta === "string") deltas.push(event.delta);
      if (type === "response.output_item.done" && isRecord(event.item)) collect(event.item);
      if ((type === "response.completed" || type === "response.done") && isRecord(event.response)) {
        completed = true; tokens = usage(event.response.usage); requestId = text(event.response.id);
        if (!answers.length) for (const item of records(event.response.output)) collect(item);
        else for (const item of records(event.response.output)) if (item.type === "web_search_call") collect(item);
        break;
      }
    }
    if (!searched || !completed) throw new SearchProviderError(this.id, "Model did not complete web search");
    const answer = answers.join("\n\n") || deltas.join("");
    if (!sources.length) for (const match of answer.matchAll(/https?:\/\/[^\s<>"\]]+/g)) add(sources, { url: match[0].replace(/[).,;]+$/, "") });
    return { provider: this.id, model, answer, sources, usage: tokens, requestId };
  }
}

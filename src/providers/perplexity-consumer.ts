// OMP consumer SSE parsing and request semantics. See NOTICE.
import { SearchProviderError, type SearchSource } from "../types";
import { dateToAgeSeconds } from "../utils";
import { readSseJson } from "../sse";
import { classifyProviderHttpError, withHardTimeout } from "./utils";
const $env = process.env;
const PERPLEXITY_OAUTH_ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const OAUTH_API_VERSION = "2.18";
const OAUTH_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const ANONYMOUS_USER_AGENT = "Mozilla/5.0";
interface PerplexitySearchParams { query: string; subscription_model?: string; search_recency_filter?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }
interface PerplexityNativeFilters { query: string; domainFilter?: string[]; afterDate?: string; beforeDate?: string; languageFilter?: string[] }
interface PerplexityOAuthStreamMarkdownBlock {
	answer?: string;
	chunks?: string[];
	chunk_starting_offset?: number;
}
interface PerplexityOAuthStreamWebResult {
	name?: string;
	url?: string;
	snippet?: string;
	timestamp?: string;
}

interface PerplexityOAuthStreamWebResultBlock {
	web_results?: PerplexityOAuthStreamWebResult[];
}

interface PerplexityOAuthStreamBlock {
	intended_usage?: string;
	markdown_block?: PerplexityOAuthStreamMarkdownBlock;
	web_result_block?: PerplexityOAuthStreamWebResultBlock;
}

interface PerplexityOAuthStreamSource {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
}

interface PerplexityOAuthStreamEvent {
	status?: string;
	final?: boolean;
	text?: string;
	blocks?: PerplexityOAuthStreamBlock[];
	sources_list?: PerplexityOAuthStreamSource[];
	error_code?: string;
	error_message?: string;
	display_model?: string;
	user_selected_model?: string;
	uuid?: string;
}

function mergeMarkdownBlock(
	existing: PerplexityOAuthStreamMarkdownBlock | undefined,
	incoming: PerplexityOAuthStreamMarkdownBlock,
): PerplexityOAuthStreamMarkdownBlock {
	if (!existing) return { ...incoming };

	const result: PerplexityOAuthStreamMarkdownBlock = { ...existing, ...incoming };
	if (incoming.chunks?.length) {
		const offset = incoming.chunk_starting_offset ?? 0;
		const existingChunks = existing.chunks ?? [];
		result.chunks = offset === 0 ? [...incoming.chunks] : [...existingChunks.slice(0, offset), ...incoming.chunks];
	}

	return result;
}

function mergeBlocks(
	existing: PerplexityOAuthStreamBlock[],
	incoming: PerplexityOAuthStreamBlock[],
): PerplexityOAuthStreamBlock[] {
	const blockMap = new Map<string, PerplexityOAuthStreamBlock>(
		existing
			.filter(block => typeof block.intended_usage === "string" && block.intended_usage.length > 0)
			.map(block => [block.intended_usage as string, block]),
	);

	for (const block of incoming) {
		if (!block.intended_usage) continue;
		const prev = blockMap.get(block.intended_usage);
		if (block.markdown_block) {
			blockMap.set(block.intended_usage, {
				...prev,
				...block,
				markdown_block: mergeMarkdownBlock(prev?.markdown_block, block.markdown_block),
			});
			continue;
		}

		blockMap.set(block.intended_usage, { ...prev, ...block });
	}

	return [...blockMap.values()];
}

function mergeOAuthEventSnapshot(
	existing: PerplexityOAuthStreamEvent,
	incoming: PerplexityOAuthStreamEvent,
): PerplexityOAuthStreamEvent {
	const merged: PerplexityOAuthStreamEvent = { ...existing, ...incoming };
	if (incoming.blocks && incoming.blocks.length > 0) {
		merged.blocks = mergeBlocks(existing.blocks ?? [], incoming.blocks);
	} else {
		merged.blocks = existing.blocks ?? [];
	}

	if (!merged.sources_list && existing.sources_list) {
		merged.sources_list = existing.sources_list;
	}

	return merged;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function parseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function textFromChunks(value: unknown): string | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	let text = "";
	for (const chunk of value) {
		if (typeof chunk !== "string") return null;
		text += chunk;
	}
	return text.length > 0 ? text : null;
}

function textFromStructuredAnswer(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	for (const item of value) {
		const record = asRecord(item);
		if (!record) continue;
		const text = record.text;
		if (typeof text === "string" && text.length > 0) return text;
		const chunks = textFromChunks(record.chunks);
		if (chunks) return chunks;
	}
	return null;
}

function answerFromTextPayload(payload: Record<string, unknown>): string | null {
	const structured = textFromStructuredAnswer(payload.structured_answer);
	if (structured) return structured;
	const chunks = textFromChunks(payload.chunks);
	if (chunks) return chunks;
	const answer = payload.answer;
	return typeof answer === "string" && answer.length > 0 ? answer : null;
}

function parseOAuthTextPayload(text: string): Record<string, unknown> | null {
	const parsed = parseJson(text);
	const direct = asRecord(parsed);
	if (direct) return direct;
	if (!Array.isArray(parsed)) return null;

	for (const item of parsed) {
		const step = asRecord(item);
		const content = asRecord(step?.content);
		const answer = content?.answer;
		if (typeof answer !== "string" || answer.length === 0) continue;
		const payload = asRecord(parseJson(answer));
		if (payload) return payload;
	}
	return null;
}

function parseOAuthTextAnswer(text: string): string {
	const payload = parseOAuthTextPayload(text);
	if (payload) {
		const answer = answerFromTextPayload(payload);
		if (answer) return answer;
	}

	const parsed = parseJson(text);
	if (!Array.isArray(parsed)) return text;
	for (const item of parsed) {
		const step = asRecord(item);
		const content = asRecord(step?.content);
		const answer = content?.answer;
		if (typeof answer === "string" && answer.length > 0) return answer;
	}
	return text;
}

function sourcesFromTextPayload(text: string | undefined): SearchSource[] {
	if (!text) return [];
	const payload = parseOAuthTextPayload(text);
	const webResults = payload?.web_results;
	if (!Array.isArray(webResults) || webResults.length === 0) return [];

	const sources: SearchSource[] = [];
	for (const value of webResults) {
		const result = asRecord(value);
		if (!result) continue;
		const url = result.url;
		if (typeof url !== "string" || url.length === 0) continue;
		const name = result.name ?? result.title;
		const snippet = result.snippet;
		const timestamp = result.timestamp;
		sources.push({
			title: typeof name === "string" && name.length > 0 ? name : url,
			url,
			snippet: typeof snippet === "string" ? snippet : undefined,
			publishedDate: typeof timestamp === "string" ? timestamp : undefined,
			ageSeconds: dateToAgeSeconds(typeof timestamp === "string" ? timestamp : undefined),
		});
	}
	return sources;
}

function oauthSourceKey(url: string): string {
	const trimmed = url.trim().replace(/\/$/, "");
	try {
		return new URL(trimmed).href.replace(/\/$/, "");
	} catch {
		return trimmed.toLowerCase();
	}
}

function buildOAuthSources(event: PerplexityOAuthStreamEvent): SearchSource[] {
	const results =
		event.blocks?.find(block => block.intended_usage === "web_results")?.web_result_block?.web_results ?? [];

	if (results.length > 0) {
		return results
			.filter(result => typeof result.url === "string" && result.url.length > 0)
			.map(result => ({
				title: result.name ?? result.url ?? "",
				url: result.url ?? "",
				snippet: result.snippet,
				publishedDate: result.timestamp,
				ageSeconds: dateToAgeSeconds(result.timestamp),
			}));
	}

	const sources = (event.sources_list ?? [])
		.filter(source => typeof source.url === "string" && source.url.length > 0)
		.map(source => ({
			title: source.title ?? source.url ?? "",
			url: source.url ?? "",
			snippet: source.snippet,
			publishedDate: source.date,
			ageSeconds: dateToAgeSeconds(source.date),
		}));
	if (sources.length > 0) return sources;
	return sourcesFromTextPayload(event.text);
}

function buildOAuthAnswer(event: PerplexityOAuthStreamEvent): string {
	if (!event.blocks?.length) {
		return typeof event.text === "string" ? parseOAuthTextAnswer(event.text) : "";
	}

	const markdownBlock = event.blocks.find(
		block => block.intended_usage?.includes("markdown") && block.markdown_block,
	)?.markdown_block;
	if (markdownBlock) {
		if (Array.isArray(markdownBlock.chunks) && markdownBlock.chunks.length > 0) {
			return markdownBlock.chunks.join("");
		}
		if (typeof markdownBlock.answer === "string" && markdownBlock.answer.length > 0) {
			return markdownBlock.answer;
		}
	}

	const textBlock = event.blocks.find(
		block => block.intended_usage === "ask_text" && block.markdown_block,
	)?.markdown_block;
	if (textBlock) {
		if (Array.isArray(textBlock.chunks) && textBlock.chunks.length > 0) {
			return textBlock.chunks.join("");
		}
		if (typeof textBlock.answer === "string" && textBlock.answer.length > 0) {
			return textBlock.answer;
		}
	}
	if (typeof event.text === "string" && event.text.length > 0) {
		return parseOAuthTextAnswer(event.text);
	}
	return "";
}


export async function callPerplexityAsk(
	auth: { type: "oauth"; token: string } | { type: "cookies"; cookies: string } | { type: "anonymous" },
	params: PerplexitySearchParams,
	filters: PerplexityNativeFilters,
): Promise<{ answer: string; sources: SearchSource[]; model?: string; requestId?: string }> {
	const subscriptionModel = params.subscription_model?.trim() || $env.PI_PERPLEXITY_MODEL?.trim() || "experimental";
	const requestId = crypto.randomUUID();
	// The consumer `perplexity_ask` endpoint is itself a research assistant and
	// has no system-message slot. Prepending the API-style system prompt to the
	// query makes the model read it as a meta-instruction and refuse with
	// "I don't have access to web-search tools in this turn", so ask-endpoint
	// searches send the bare query. (The API-key path still uses system_prompt
	// as a proper `system` message.)
	const effectiveQuery = filters.query;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		Origin: "https://www.perplexity.ai",
		Referer: "https://www.perplexity.ai/",
		"User-Agent": auth.type === "anonymous" ? ANONYMOUS_USER_AGENT : OAUTH_USER_AGENT,
		"X-Request-ID": requestId,
	};
	if (auth.type === "oauth") {
		// The ask endpoint authenticates via the next-auth session cookie, NOT a
		// bearer header — a bearer (even a garbage one) is ignored and the request
		// silently falls back to the anonymous free `turbo` model regardless of
		// `model_preference`. The stored OAuth token IS the Perplexity session JWT
		// (the native app injects the same value as this cookie), so sending it as
		// the cookie is what unlocks the account's Pro model selection.
		headers.Cookie = `__Secure-next-auth.session-token=${auth.token}`;
	} else if (auth.type === "cookies") {
		headers.Cookie = auth.cookies;
	}
	if (auth.type !== "anonymous") {
		headers["X-App-ApiClient"] = "default";
		headers["X-App-ApiVersion"] = OAUTH_API_VERSION;
		headers["X-Perplexity-Request-Reason"] = "submit";
	}

	const requestParams: Record<string, unknown> = {
		query_str: effectiveQuery,
		search_focus: "internet",
		mode: "copilot",
		model_preference: subscriptionModel,
		sources: ["web"],
		attachments: [],
		frontend_uuid: crypto.randomUUID(),
		frontend_context_uuid: crypto.randomUUID(),
		version: OAUTH_API_VERSION,
		language: "en-US",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
		// Recency cannot be combined with absolute date filters; explicit
		// before:/after: bounds take precedence.
		search_recency_filter: filters.afterDate || filters.beforeDate ? null : (params.search_recency_filter ?? null),
		is_incognito: true,
		use_schematized_api: true,
		// `true` (the native app's default) lets the backend classifier skip
		// retrieval for queries it deems answerable from memory — the model then
		// runs ungrounded and refuses with "I don't currently have live access".
		// We are a search tool; always retrieve.
		skip_search_enabled: false,
		// Belt and braces with `skip_search_enabled: false`: the web client sets
		// this to force retrieval even when the skip classifier fires.
		always_search_override: true,
		prompt_source: "user",
		source: "default",
		local_search_enabled: false,
		// Declare no tool-approval UI and no local (Comet) browser agent, so the
		// stream never stalls waiting for a confirmation we cannot render.
		should_ask_for_mcp_tool_confirmation: false,
		supports_tool_approval_modal: false,
		force_enable_browser_agent: false,
		is_local_browser_available: false,
		is_local_browser_allowed: false,
	};
	if (auth.type === "anonymous") {
		requestParams.send_back_text_in_streaming_api = true;
	}
	if (filters.domainFilter) requestParams.search_domain_filter = filters.domainFilter;
	if (filters.afterDate) requestParams.search_after_date_filter = filters.afterDate;
	if (filters.beforeDate) requestParams.search_before_date_filter = filters.beforeDate;
	if (filters.languageFilter) requestParams.search_language_filter = filters.languageFilter;

	const requestInit = {
		method: "POST",
		headers,
		body: JSON.stringify({
			query_str: effectiveQuery,
			params: requestParams,
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	};

	// The consumer ask endpoint intermittently drops the socket before sending an
	// HTTP response (#5315). Retry the transport exactly once; once we hold an
	// HTTP response (handled below) the outcome — including non-2xx — is final and
	// never retried, so a real 401/429 is never papered over by a second attempt.
	let response: Response;
	try {
		response = await (params.fetch ?? fetch)(PERPLEXITY_OAUTH_ASK_URL, requestInit);
	} catch (error) {
		if (params.signal?.aborted) throw error;
		response = await (params.fetch ?? fetch)(PERPLEXITY_OAUTH_ASK_URL, requestInit);
	}

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("perplexity", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"perplexity",
			`Perplexity ask API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response.body) {
		throw new SearchProviderError("perplexity", "Perplexity ask API returned no response body", 500);
	}

	let answer = "";
	let model: string | undefined;
	let finalRequestId: string | undefined;
	const sourcesByUrl = new Map<string, SearchSource>();
	let mergedEvent: PerplexityOAuthStreamEvent = { blocks: [] };

	for await (const event of readSseJson(response.body, "perplexity", params.signal)) {
		if (event.error_code) {
			const message = event.error_message ?? event.error_code;
			throw new SearchProviderError("perplexity", `Perplexity ask stream error: ${message}`, 400);
		}

		mergedEvent = mergeOAuthEventSnapshot(mergedEvent, event as PerplexityOAuthStreamEvent);

		const eventAnswer = buildOAuthAnswer(mergedEvent);
		if (eventAnswer.length > 0) {
			answer = eventAnswer;
		}
		for (const source of buildOAuthSources(mergedEvent)) {
			sourcesByUrl.set(oauthSourceKey(source.url), source);
		}

		const reportedModel = [mergedEvent.user_selected_model, mergedEvent.display_model].find(
			candidate => candidate && candidate !== "turbo",
		);
		if (reportedModel) model = reportedModel;
		if (mergedEvent.uuid) finalRequestId = mergedEvent.uuid;
		if (mergedEvent.final || mergedEvent.status === "COMPLETED") {
			break;
		}
	}

	return {
		answer,
		sources: [...sourcesByUrl.values()],
		model: model ?? (auth.type === "anonymous" ? mergedEvent.display_model : subscriptionModel),
		requestId: finalRequestId ?? requestId,
	};
}


// OpenAI-compatible chat/completions: the request body and how its reply is read.
// No Obsidian imports, so the eval scripts send exactly what the plugin sends.

import { buildPrompts, extractResult, JSON_INSTRUCTION, passageOf, PromptLayout, ReviewError, ReviewInput, ReviewResult } from "./prompt";
import { t } from "./i18n";

export interface ChatBody {
	model: string;
	messages: Array<{ role: "system" | "user"; content: string }>;
	temperature: number;
	response_format?: { type: "json_object" };
}

/** Token counts as DeepSeek and most OpenAI-compatible APIs report them. */
export interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	/** DeepSeek: input tokens served from its context cache, and the rest. */
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

export interface ChatResponse {
	choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> }; finish_reason?: string }>;
	usage?: ChatUsage;
	error?: { message?: string };
}

export function chatURL(baseURL: string): string {
	return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

export function buildChatBody(model: string, input: ReviewInput, layout: PromptLayout): ChatBody {
	const { system, user } = buildPrompts(input, layout, JSON_INSTRUCTION);
	return {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		temperature: 0.2,
		response_format: { type: "json_object" },
	};
}

/** True when the endpoint rejected the request only because it doesn't support response_format. */
export function rejectsResponseFormat(status: number, text: string): boolean {
	return status === 400 && /response_format|json_object/i.test(text);
}

export function withoutResponseFormat(body: ChatBody): ChatBody {
	const plain = { ...body };
	delete plain.response_format;
	return plain;
}

/** Turns an HTTP reply into a review result, or throws a ReviewError with a readable message. */
export function readChatReply(status: number, text: string, input: ReviewInput): ReviewResult {
	if (status >= 400) throw new ReviewError(describeHttpError(status, text));
	let data: ChatResponse;
	try {
		data = JSON.parse(text) as ChatResponse;
	} catch {
		throw new ReviewError(t().notJson);
	}
	const choice = data.choices?.[0];
	if (!choice) throw new ReviewError(data.error?.message ? t().apiError(data.error.message) : t().noResult);
	if (choice.finish_reason === "length") throw new ReviewError(t().tooLong);
	if (choice.finish_reason === "content_filter") throw new ReviewError(t().filtered);

	const raw = choice.message?.content;
	const content = typeof raw === "string" ? raw : (raw ?? []).map((p) => p.text ?? "").join("");
	const result = extractResult(content, passageOf(input));
	if (!result) throw new ReviewError(t().unparsable);
	return result;
}

export function describeHttpError(status: number, text: string): string {
	let detail = "";
	try {
		detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
	} catch {
		detail = text.slice(0, 200);
	}
	const suffix = detail ? t().sep + detail : "";
	if (status === 401 || status === 403) return t().badKey(suffix);
	if (status === 402) return t().noBalance(suffix);
	if (status === 404) return t().notFound(suffix);
	if (status === 429) return t().rateLimited(suffix);
	if (status >= 500) return t().serverDown(suffix);
	return t().requestFailed(status, suffix);
}

// ---------- model catalogue (GET /models) ----------

export function modelsURL(baseURL: string): string {
	return `${baseURL.replace(/\/+$/, "")}/models`;
}

/** Catalogue entries that can't answer a chat request (embeddings, speech, images, video...). */
const NON_CHAT = /embed|whisper|tts|transcribe|dall-e|imagen|veo|lyria|moderation|realtime|audio|aqa|image-generation/i;

/**
 * Model IDs from an OpenAI-style `{ data: [{ id }] }` list, chat models only, sorted.
 * Gemini's compatible endpoint prefixes IDs with "models/", which chat requests don't need.
 */
export function parseModelList(status: number, text: string): string[] {
	if (status >= 400) throw new ReviewError(describeHttpError(status, text));
	type Entry = { id?: unknown; name?: unknown };
	let data: { data?: Entry[]; models?: Entry[] };
	try {
		data = JSON.parse(text) as typeof data;
	} catch {
		throw new ReviewError(t().notJson);
	}
	const raw = (data.data ?? data.models ?? [])
		.map((m) => (typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : ""))
		.map((id) => id.replace(/^models\//, ""))
		.filter(Boolean);
	const chat = raw.filter((id) => !NON_CHAT.test(id));
	return [...new Set(chat.length ? chat : raw)].sort((a, b) => a.localeCompare(b));
}

import { requestUrl } from "obsidian";
import { buildChatBody, chatURL, ChatBody, readChatReply, rejectsResponseFormat, withoutResponseFormat } from "./chat";
import { t } from "./i18n";
import { PROMPT_LAYOUT, ReviewError, ReviewInput, ReviewResult } from "./prompt";
import type { ProofreaderSettings } from "./settings";

/**
 * Same job as reviewPassage, over any OpenAI-compatible chat/completions endpoint
 * (DeepSeek, Gemini, OpenRouter, ...). Goes through Obsidian's requestUrl, which
 * isn't subject to the renderer's CORS rules, so no provider-side CORS is needed.
 */
export async function reviewPassageOpenAI(
	settings: ProofreaderSettings,
	apiKey: string,
	input: ReviewInput,
	signal: AbortSignal,
): Promise<ReviewResult> {
	const url = chatURL(settings.openaiBaseURL);
	const body = buildChatBody(settings.openaiModel, input, PROMPT_LAYOUT);

	let res = await post(url, apiKey, body);
	// Some endpoints reject response_format; the prompt already asks for JSON, so retry without it.
	if (rejectsResponseFormat(res.status, res.text)) res = await post(url, apiKey, withoutResponseFormat(body));
	if (signal.aborted) throw new ReviewError(t().cancelled);
	return readChatReply(res.status, res.text, input);
}

async function post(url: string, apiKey: string, body: ChatBody) {
	try {
		return await requestUrl({
			url,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				// OpenRouter likes to know who's calling; harmless elsewhere.
				"HTTP-Referer": "https://github.com/jiwawang/obsidian-note-proofreader",
				"X-Title": "Veritas Howler",
			},
			body: JSON.stringify(body),
			throw: false,
		});
	} catch (e) {
		throw new ReviewError(t().cantConnect(e instanceof Error ? e.message : String(e)));
	}
}

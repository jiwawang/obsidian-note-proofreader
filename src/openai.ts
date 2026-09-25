import { requestUrl } from "obsidian";
import { buildPrompts, normalizeResult, ReviewError, ReviewInput, ReviewResult } from "./claude";
import type { ProofreaderSettings } from "./settings";

const JSON_INSTRUCTION =
	'Respond with a single JSON object and nothing else, with exactly these keys: "verdict" ("correct" or "corrected"), "explanation" (the note to the author described above), "revised" (the passage with only the required corrections; identical to the original when nothing needs to change).';

interface ChatResponse {
	choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> }; finish_reason?: string }>;
	error?: { message?: string };
}

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
	const { system, user } = buildPrompts(input, JSON_INSTRUCTION);
	const url = `${settings.openaiBaseURL.replace(/\/+$/, "")}/chat/completions`;
	const body = {
		model: settings.openaiModel,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		temperature: 0.2,
		response_format: { type: "json_object" },
	};

	let res = await post(url, apiKey, body);
	// Some endpoints reject response_format; the prompt already asks for JSON, so retry without it.
	if (res.status === 400 && /response_format|json_object/i.test(res.text)) {
		const { response_format: _drop, ...plain } = body;
		res = await post(url, apiKey, plain);
	}
	if (signal.aborted) throw new ReviewError("已取消。");
	if (res.status >= 400) throw new ReviewError(describeHttpError(res.status, res.text));

	let data: ChatResponse;
	try {
		data = res.json as ChatResponse;
	} catch {
		throw new ReviewError("接口返回的不是 JSON，请检查接口地址是否正确。");
	}
	const choice = data.choices?.[0];
	if (!choice) throw new ReviewError(data.error?.message ? `接口错误：${data.error.message}` : "接口没有返回结果，请重试。");
	if (choice.finish_reason === "length") throw new ReviewError("输出超出长度上限，请缩短选中的段落后重试。");
	if (choice.finish_reason === "content_filter") throw new ReviewError("模型拒绝处理这段内容。");

	const raw = choice.message?.content;
	const text = typeof raw === "string" ? raw : (raw ?? []).map((p) => p.text ?? "").join("");
	const result = extractResult(text, input.passage);
	if (!result) throw new ReviewError("无法解析模型的返回结果，请重试或换一个模型。");
	return result;
}

async function post(url: string, apiKey: string, body: unknown) {
	try {
		return await requestUrl({
			url,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				// OpenRouter likes to know who's calling; harmless elsewhere.
				"HTTP-Referer": "https://github.com/note-proofreader",
				"X-Title": "Note Proofreader",
			},
			body: JSON.stringify(body),
			throw: false,
		});
	} catch (e) {
		throw new ReviewError(`无法连接到接口：${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Pulls the result object out of the model's reply, tolerating code fences and stray prose. */
function extractResult(text: string, original: string): ReviewResult | null {
	const candidates = [text.trim()];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) candidates.unshift(fenced[1].trim());
	const braces = text.match(/\{[\s\S]*\}/);
	if (braces) candidates.push(braces[0]);
	for (const c of candidates) {
		try {
			const result = normalizeResult(JSON.parse(c), original);
			if (result) return result;
		} catch {
			// try the next shape
		}
	}
	return null;
}

function describeHttpError(status: number, text: string): string {
	let detail = "";
	try {
		detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "";
	} catch {
		detail = text.slice(0, 200);
	}
	const suffix = detail ? `：${detail}` : "";
	if (status === 401 || status === 403) return `API Key 无效或没有权限${suffix}`;
	if (status === 402) return `账户余额不足${suffix}`;
	if (status === 404) return `找不到接口或模型，请检查接口地址和模型 ID${suffix}`;
	if (status === 429) return `请求过于频繁或超出额度，请稍后再试${suffix}`;
	if (status >= 500) return `模型服务暂时不可用，请稍后再试${suffix}`;
	return `请求失败（${status}）${suffix}`;
}

import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ProofreaderSettings } from "./settings";

export interface ReviewInput {
	passage: string;
	/** The note text with the passage wrapped in <selection> tags. */
	context: string;
	noteTitle: string;
	/** The author's one-off instructions for this run; empty for a facts-only pass. */
	extra: string;
}

export interface ReviewResult {
	revised: string;
	verdict: "correct" | "corrected";
	/** Short feedback for the author: what was checked, what (if anything) was wrong, and a one-breath recap. */
	explanation: string;
}

const RESULT_SCHEMA = {
	type: "object",
	properties: {
		verdict: {
			type: "string",
			enum: ["correct", "corrected"],
			description: '"correct" when the passage needed no change, "corrected" when something was fixed.',
		},
		explanation: {
			type: "string",
			description: "Feedback for the author, in the passage's language, following the rules in the system prompt.",
		},
		revised: {
			type: "string",
			description: "The passage with only the required corrections applied; identical to the original when nothing needs to change.",
		},
	},
	required: ["verdict", "explanation", "revised"],
	additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a fact-checker working inside the author's personal note-taking app (Obsidian). The author selects a passage from one of their notes; you check it and return a version that goes straight back into the note in place of the selection, without the author reviewing it first.

The author's own words take priority. They wrote the passage in their own understanding and voice, and they want to keep it that way. Your only job is to catch things that are actually wrong.

Change text only when:
- A factual claim, definition, formula, number, unit, date, name, or piece of code is incorrect, and you are confident of that. Fix it with the smallest edit that makes it right, in the author's own wording and register.
- A step of reasoning is invalid, so the conclusion does not follow. Fix the step, not the surrounding prose.
- The author has given extra instructions for this run (see below); apply exactly those.

Leave everything else exactly as written, character for character: typos, grammar, punctuation, awkward phrasing, repetition, informal tone, mixed languages, the author's own opinions, simplifications the author clearly made on purpose, and anything you merely find suboptimal. Never add new facts, examples, caveats or explanations. Never reorganize.

When you are not sure whether something is wrong, because it depends on recent events, private context, or knowledge you lack, leave it unchanged.

Preserve Markdown and Obsidian syntax exactly: headings, list markers and indentation, [[wikilinks]], ![[embeds]], #tags, links, footnotes, callouts, LaTeX ($...$ and $$...$$), inline code and code blocks, and the line-break structure.

In "revised", return only the passage: no surrounding context, no quotation marks, no commentary. If nothing needs to change, return the original passage unchanged.

"explanation" is a short note to the author (2–4 sentences, plain text, no Markdown), written in the passage's own language:
- If nothing was wrong, open with the equivalent of 「你的思路没有问题，」("Your reasoning holds up — ") and then briefly recap the key point of the passage so the author can confirm their understanding.
- If something was corrected, first say what was wrong and why, then briefly recap the correct idea. Keep to the errors you actually fixed.
- Never mention typos, style or wording you left alone.`;

/** System and user prompts shared by every provider. */
export function buildPrompts(input: ReviewInput, jsonInstruction = ""): { system: string; user: string } {
	let system = SYSTEM_PROMPT;
	const extra = input.extra.trim();
	if (extra) {
		system += `

Extra instructions from the author for this run (apply these in addition to fixing errors):
${extra}`;
	}
	if (jsonInstruction) system += `

${jsonInstruction}`;
	const user = `<note title="${input.noteTitle.replace(/"/g, "'")}">
${input.context}
</note>

<passage>
${input.passage}
</passage>

Check the passage (marked with <selection> inside the note above) and return it with only the required corrections.`;
	return { system, user };
}

// Models whose safety classifiers can decline benign requests; for these we opt
// into server-side fallbacks so a false positive doesn't fail the whole check.
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]);

export class ReviewError extends Error {}

/** Returns the corrected passage plus feedback for the author. */
export async function reviewPassage(
	settings: ProofreaderSettings,
	apiKey: string,
	input: ReviewInput,
	signal: AbortSignal,
): Promise<ReviewResult> {
	const client = new Anthropic({
		apiKey,
		baseURL: settings.baseURL.trim() || undefined,
		// Obsidian runs in a browser context; the key stays on the user's own machine.
		dangerouslyAllowBrowser: true,
	});

	const model = settings.model.trim();
	const isHaiku = model.includes("haiku");
	const useFallbacks = settings.useFallbacks && FALLBACK_MODELS.has(model);
	const { system, user: userMessage } = buildPrompts(input);

	const params: MessageCreateParamsStreaming = {
		model,
		max_tokens: 64000,
		stream: true,
		system,
		messages: [{ role: "user", content: userMessage }],
		output_config: {
			format: { type: "json_schema", schema: RESULT_SCHEMA },
			...(isHaiku ? {} : { effort: settings.effort }),
		},
		...(isHaiku ? {} : { thinking: { type: "adaptive" as const } }),
		...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
	};

	let message;
	try {
		message = await client.beta.messages.stream(params, { signal }).finalMessage();
	} catch (e) {
		throw new ReviewError(describeApiError(e));
	}

	if (message.stop_reason === "refusal") {
		const detail = message.stop_details?.explanation;
		throw new ReviewError(`Claude 拒绝处理这段内容${detail ? `：${detail}` : "。"}`);
	}
	if (message.stop_reason === "max_tokens") {
		throw new ReviewError("输出超出长度上限，请缩短选中的段落后重试。");
	}

	const text = message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ReviewError("无法解析 Claude 的返回结果，请重试。");
	}
	const result = normalizeResult(parsed, input.passage);
	if (!result) throw new ReviewError("Claude 的返回结果格式不完整，请重试。");
	return result;
}

/** Accepts the model's object loosely: only `revised` is essential, the rest is inferred. */
export function normalizeResult(obj: unknown, original: string): ReviewResult | null {
	if (!obj || typeof obj !== "object") return null;
	const o = obj as { revised?: unknown; verdict?: unknown; explanation?: unknown };
	if (typeof o.revised !== "string") return null;
	const changed = o.revised.trim() !== original.trim();
	const verdict = o.verdict === "correct" || o.verdict === "corrected" ? o.verdict : changed ? "corrected" : "correct";
	return { revised: o.revised, verdict, explanation: typeof o.explanation === "string" ? o.explanation.trim() : "" };
}

function describeApiError(e: unknown): string {
	if (e instanceof Anthropic.APIUserAbortError) return "已取消。";
	if (e instanceof Anthropic.AuthenticationError) return "API Key 无效，请在插件设置中检查。";
	if (e instanceof Anthropic.PermissionDeniedError) return "该 API Key 没有权限使用所选模型。";
	if (e instanceof Anthropic.NotFoundError) return "找不到所选模型，请检查设置中的模型名称。";
	if (e instanceof Anthropic.RateLimitError) return "请求过于频繁或额度不足，请稍后再试。";
	if (e instanceof Anthropic.BadRequestError) return `请求被拒绝：${apiMessage(e)}`;
	if (e instanceof Anthropic.InternalServerError) return "Claude 服务暂时不可用，请稍后再试。";
	if (e instanceof Anthropic.APIConnectionError) return "无法连接到 Claude API，请检查网络或自定义 API 地址。";
	if (e instanceof Anthropic.APIError) return `API 错误：${apiMessage(e)}`;
	return e instanceof Error ? e.message : String(e);
}

/** The human-readable message from an API error body, rather than the raw JSON. */
function apiMessage(e: InstanceType<typeof Anthropic.APIError>): string {
	const body = e.error as { error?: { message?: string } } | undefined;
	return body?.error?.message ?? e.message;
}

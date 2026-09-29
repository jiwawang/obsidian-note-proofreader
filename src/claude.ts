import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { buildPrompts, normalizeResult, passageOf, PROMPT_LAYOUT, ReviewError, ReviewInput, ReviewResult } from "./prompt";
import { t } from "./i18n";
import type { ProofreaderSettings } from "./settings";

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

// Models whose safety classifiers can decline benign requests; for these we opt
// into server-side fallbacks so a false positive doesn't fail the whole check.
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]);

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
	const { system, user: userMessage } = buildPrompts(input, PROMPT_LAYOUT);

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
		throw new ReviewError(t().claudeRefused(detail ?? ""));
	}
	if (message.stop_reason === "max_tokens") {
		throw new ReviewError(t().tooLong);
	}

	const text = message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ReviewError(t().claudeUnparsable);
	}
	const result = normalizeResult(parsed, passageOf(input));
	if (!result) throw new ReviewError(t().claudeIncomplete);
	return result;
}

function describeApiError(e: unknown): string {
	if (e instanceof Anthropic.APIUserAbortError) return t().cancelled;
	if (e instanceof Anthropic.AuthenticationError) return t().claudeBadKey;
	if (e instanceof Anthropic.PermissionDeniedError) return t().claudeNoPermission;
	if (e instanceof Anthropic.NotFoundError) return t().claudeNoModel;
	if (e instanceof Anthropic.RateLimitError) return t().claudeRateLimited;
	if (e instanceof Anthropic.BadRequestError) return t().claudeBadRequest(apiMessage(e.error, e.message));
	if (e instanceof Anthropic.InternalServerError) return t().claudeDown;
	if (e instanceof Anthropic.APIConnectionError) return t().claudeCantConnect;
	if (e instanceof Anthropic.APIError) return t().apiError(apiMessage(e.error, e.message));
	return e instanceof Error ? e.message : String(e);
}

/** The human-readable message from an API error body, rather than the raw JSON. */
function apiMessage(error: unknown, fallback: string): string {
	const body = error as { error?: { message?: string } } | undefined;
	return body?.error?.message ?? fallback;
}

// Everything that decides what the model sees and how its reply is read.
// Kept free of Obsidian and SDK imports so the eval scripts can use the exact
// same code the plugin ships.

export interface ReviewInput {
	noteTitle: string;
	/** The whole note. */
	doc: string;
	/** The selected passage is doc.slice(from, to). */
	from: number;
	to: number;
	/** How many characters of the note to send around the passage. */
	contextChars: number;
	/** The author's one-off instructions for this run; empty for a facts-only pass. */
	extra: string;
}

export interface ReviewResult {
	revised: string;
	verdict: "correct" | "corrected";
	/** Short feedback for the author: what was checked, what (if anything) was wrong, and a one-breath recap. */
	explanation: string;
}

export class ReviewError extends Error {}

/**
 * How the request is laid out.
 * - "inline": the note is sent with the passage wrapped in <selection> tags, and
 *   extra instructions go into the system prompt. (Shipped up to 0.3.x.)
 * - "prefix": the note is sent unmarked, in a window that stays the same for
 *   nearby selections, and everything that varies per review comes after it, so
 *   consecutive reviews of one note share a long cacheable prefix.
 */
export type PromptLayout = "inline" | "prefix";

/** The layout the plugin uses. */
export const PROMPT_LAYOUT: PromptLayout = "inline";

export const SYSTEM_PROMPT = `You are a fact-checker working inside the author's personal note-taking app (Obsidian). The author selects a passage from one of their notes; you check it and return a version that goes straight back into the note in place of the selection, without the author reviewing it first.

The author's own words take priority. They wrote the passage in their own understanding and voice, and they want to keep it that way. Your only job is to catch things that are actually wrong.

Change text only when:
- A factual claim, definition, formula, number, unit, date, name, or piece of code is incorrect, and you are confident of that. Fix it with the smallest edit that makes it right, in the author's own wording and register.
- A step of reasoning is invalid, so the conclusion does not follow. Fix the step, not the surrounding prose.
- The author has given extra instructions for this run (see below); apply exactly those.

Leave everything else exactly as written, character for character: typos, grammar, punctuation, awkward phrasing, repetition, informal tone, mixed languages, the author's own opinions, simplifications the author clearly made on purpose, and anything you merely find suboptimal. Never add new facts, examples, caveats or explanations. Never reorganize.

When you are not sure whether something is wrong, because it depends on recent events, private context, or knowledge you lack, leave it unchanged.

Preserve Markdown and Obsidian syntax exactly: headings, list markers and indentation, [[wikilinks]], ![[embeds]], #tags, links, footnotes, callouts, LaTeX ($...$ and $$...$$), inline code and code blocks, and the line-break structure.

In "revised", return only the passage: no surrounding context, no quotation marks, no commentary. If nothing needs to change, return the original passage unchanged.

"explanation" is feedback from a good teacher to the author (plain text, no Markdown or LaTeX), written in the passage's own language. Up to 5 sentences; shorter is better when there is nothing more worth saying. Rules:
- Open with a verdict, not a pleasantry: state directly whether the passage is right, and what exactly is right or wrong. Do not use stock openers such as 「你的思路没有问题」 or "Your reasoning holds up".
- If it is right: name the key insight the author got (the one thing that makes the reasoning work), in one or two sentences, using the author's own terms and metaphors. Do not paraphrase the whole passage back.
- If something was corrected: say what was wrong and why it is wrong (the root of the confusion, not just the replacement value), then the correct understanding in one sentence.
- Then, only if there is one, add a single pointed remark a teacher would add: a condition the claim depends on, a case where it breaks down, an easy confusion to watch for, or an imprecision you deliberately left in the text. This may go beyond what you changed. If nothing genuinely useful comes to mind, stop instead of padding.
- Never comment on typos, grammar, style or wording.`;

/** Appended for providers without schema-enforced output. */
export const JSON_INSTRUCTION =
	'Respond with a single JSON object and nothing else, with exactly these keys: "verdict" ("correct" or "corrected"), "explanation" (the note to the author described above), "revised" (the passage with only the required corrections; identical to the original when nothing needs to change).';

export function passageOf(input: ReviewInput): string {
	return input.doc.slice(input.from, input.to);
}

const quoteTitle = (title: string) => title.replace(/"/g, "'");

/** The system and user messages for one review. */
export function buildPrompts(input: ReviewInput, layout: PromptLayout, jsonInstruction = ""): { system: string; user: string } {
	const extra = input.extra.trim();
	const passage = passageOf(input);

	if (layout === "inline") {
		let system = SYSTEM_PROMPT;
		if (extra) {
			system += `\n\nExtra instructions from the author for this run (apply these in addition to fixing errors):\n${extra}`;
		}
		if (jsonInstruction) system += `\n\n${jsonInstruction}`;
		const user = `<note title="${quoteTitle(input.noteTitle)}">
${inlineContext(input.doc, input.from, input.to, input.contextChars)}
</note>

<passage>
${passage}
</passage>

Check the passage (marked with <selection> inside the note above) and return it with only the required corrections.`;
		return { system, user };
	}

	// "prefix": nothing that changes between reviews of the same note comes before the note text.
	const system = jsonInstruction ? `${SYSTEM_PROMPT}\n\n${jsonInstruction}` : SYSTEM_PROMPT;
	const { start, end } = stableWindow(input.doc.length, input.from, input.to, input.contextChars);
	const note =
		(start > 0 ? "[…]\n" : "") + input.doc.slice(start, end) + (end < input.doc.length ? "\n[…]" : "");
	let user = `<note title="${quoteTitle(input.noteTitle)}">
${note}
</note>

<passage>
${passage}
</passage>
`;
	if (extra) user += `\n<extra_instructions>\n${extra}\n</extra_instructions>\n`;
	user += `\nThe passage above is quoted from the note. Check it and return it with only the required corrections.`;
	return { system, user };
}

/** The note with the passage wrapped in <selection>, trimmed to about maxChars centred on it. */
export function inlineContext(doc: string, from: number, to: number, maxChars: number): string {
	let start = 0;
	let end = doc.length;
	if (doc.length > maxChars) {
		const budget = Math.max(0, maxChars - (to - from));
		const before = Math.min(from, Math.max(Math.floor(budget / 2), budget - (doc.length - to)));
		start = from - before;
		end = Math.min(doc.length, to + (budget - before));
	}
	return (
		(start > 0 ? "[…]\n" : "") +
		doc.slice(start, from) +
		"<selection>" +
		doc.slice(from, to) +
		"</selection>" +
		doc.slice(to, end) +
		(end < doc.length ? "\n[…]" : "")
	);
}

/**
 * A window of about maxChars that contains [from, to). Its start snaps to a grid
 * of maxChars/4, so selections near each other get the identical window (and so
 * an identical, cacheable prefix). Short notes are always sent whole.
 */
export function stableWindow(docLength: number, from: number, to: number, maxChars: number): { start: number; end: number } {
	if (docLength <= maxChars) return { start: 0, end: docLength };
	const step = Math.max(1, Math.floor(maxChars / 4));
	const centre = (from + to) / 2;
	let start = Math.floor((centre - maxChars / 2) / step) * step;
	start = Math.max(0, Math.min(start, docLength - maxChars));
	if (from < start) start = Math.floor(from / step) * step;
	const end = Math.max(Math.min(docLength, start + maxChars), to);
	return { start, end };
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

/** Pulls the result object out of a model reply, tolerating code fences and stray prose. */
export function extractResult(text: string, original: string): ReviewResult | null {
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

/** Models tend to trim or add edge whitespace; keep the selection's own so it fits back in. */
export function keepOuterWhitespace(original: string, revised: string): string {
	if (!revised.trim()) return original;
	const lead = original.match(/^\s*/)?.[0] ?? "";
	const trail = original.match(/\s*$/)?.[0] ?? "";
	return lead + revised.trim() + trail;
}

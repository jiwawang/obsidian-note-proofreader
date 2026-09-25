import { diffArrays } from "diff";

/** A stretch of the passage that is either left alone or swapped out. */
export type Hunk =
	| { type: "keep"; text: string }
	| { type: "change"; del: string; ins: string };

// Word segmentation handles both CJK (dictionary-based) and space-separated
// languages, so a Chinese edit doesn't show up as one giant character soup.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function tokenize(text: string): string[] {
	return Array.from(wordSegmenter.segment(text), (s) => s.segment);
}

export function graphemes(text: string): string[] {
	return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

/** A kept run so small that animating around it looks choppy. */
function isTrivialKeep(text: string): boolean {
	if (text.includes("\n")) return false;
	return text.trim() === "" || graphemes(text).length <= 1;
}

export function computeHunks(original: string, revised: string): Hunk[] {
	const raw: Hunk[] = [];
	for (const part of diffArrays(tokenize(original), tokenize(revised))) {
		const text = part.value.join("");
		const last = raw[raw.length - 1];
		if (!part.added && !part.removed) {
			raw.push({ type: "keep", text });
		} else if (last?.type === "change") {
			if (part.added) last.ins += text;
			else last.del += text;
		} else {
			raw.push({ type: "change", del: part.removed ? text : "", ins: part.added ? text : "" });
		}
	}

	// Fold tiny unchanged gaps (a space, a comma) into the surrounding edits so
	// "A B" -> "C D" erases and retypes once instead of stuttering twice.
	const hunks: Hunk[] = [];
	for (let i = 0; i < raw.length; i++) {
		const h = raw[i];
		const prev = hunks[hunks.length - 1];
		const next = raw[i + 1];
		if (h.type === "keep" && prev?.type === "change" && next?.type === "change" && isTrivialKeep(h.text)) {
			prev.del += h.text + next.del;
			prev.ins += h.text + next.ins;
			i++;
			continue;
		}
		hunks.push(h);
	}
	return hunks;
}

/** Wraps every inserted span in `marker` (e.g. "**" or "=="), leaving edge whitespace and newlines outside. */
export function wrapInsertions(hunks: Hunk[], marker: string): Hunk[] {
	return hunks.map((h) => {
		if (h.type !== "change" || !h.ins.trim()) return h;
		const ins = h.ins
			.split("\n")
			.map((line) => {
				const lead = line.match(/^\s*/)![0];
				const trail = line.match(/\s*$/)![0];
				const core = line.trim();
				return core ? `${lead}${marker}${core}${marker}${trail}` : line;
			})
			.join("\n");
		return { type: "change", del: h.del, ins };
	});
}

/** Applies a permanent mark (written into the text) if `mark` asks for one. */
export function applyPermanentMark(hunks: Hunk[], mark: string): Hunk[] {
	if (mark === "bold-permanent") return wrapInsertions(hunks, "**");
	if (mark === "highlight-permanent") return wrapInsertions(hunks, "==");
	return hunks;
}

export function joinRevised(hunks: Hunk[]): string {
	return hunks.map((h) => (h.type === "keep" ? h.text : h.ins)).join("");
}

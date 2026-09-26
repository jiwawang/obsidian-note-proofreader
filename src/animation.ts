import { EditorState, Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { Hunk } from "./diff";
import type { AnimationParams } from "./params";
import { Glyph, measureGlyphs, ParticleLayer, textWidth } from "./particles";

type Group = "pending" | "hidden" | "changed" | "flash" | "gap" | "feedback";

interface DecoSpec {
	from: number;
	to: number;
	group: Group;
	cls: string;
	/** Which hunk a "hidden" mark belongs to, so it can be lifted on its own. */
	hid?: number;
	style?: string;
}

const addDecos = StateEffect.define<DecoSpec[]>();
const clearGroup = StateEffect.define<Group>();
const unhide = StateEffect.define<number>();
const setLock = StateEffect.define<boolean>();
/** Replace [from, to) of hunk `hid` with an empty inline box `width` px wide (animates via CSS). */
const setGap = StateEffect.define<{ hid: number; from: number; to: number; width: number; shiftMs: number }>();
const clearGap = StateEffect.define<number>();

export interface Feedback {
	kind: "ok" | "fixed";
	title: string;
	body: string;
}
/** Show a feedback card on its own line right after `pos`'s line. */
const showFeedbackEffect = StateEffect.define<{ pos: number; feedback: Feedback }>();

class FeedbackWidget extends WidgetType {
	constructor(readonly feedback: Feedback) {
		super();
	}
	eq(other: FeedbackWidget) {
		return other.feedback === this.feedback;
	}
	toDOM(view: EditorView) {
		const { kind, title, body } = this.feedback;
		// A zero-height anchor so the card floats over the lines below instead of pushing them down.
		const anchor = document.createElement("div");
		anchor.className = "np-feedback-anchor";
		const card = anchor.appendChild(document.createElement("div"));
		card.className = `np-feedback np-feedback-${kind}`;
		const head = card.appendChild(document.createElement("div"));
		head.className = "np-feedback-title";
		head.textContent = title;
		if (body) {
			const p = card.appendChild(document.createElement("div"));
			p.className = "np-feedback-body";
			p.textContent = body;
		}
		const close = card.appendChild(document.createElement("button"));
		close.type = "button";
		close.className = "np-feedback-close";
		close.setAttribute("aria-label", "关闭");
		close.textContent = "×";
		close.addEventListener("mousedown", (e) => e.preventDefault());
		close.addEventListener("click", (e) => {
			e.preventDefault();
			hideFeedback(view);
		});
		return anchor;
	}
	ignoreEvent() {
		return true;
	}
}

class GapWidget extends WidgetType {
	constructor(
		readonly width: number,
		readonly shiftMs: number,
	) {
		super();
	}
	eq(other: GapWidget) {
		return other.width === this.width;
	}
	toDOM() {
		const el = document.createElement("span");
		el.className = "np-gap";
		el.style.setProperty("--np-shift", `${this.shiftMs}ms`);
		el.style.width = `${this.width}px`;
		return el;
	}
	// Reuse the element so the width change runs as a CSS transition.
	updateDOM(el: HTMLElement) {
		el.style.width = `${this.width}px`;
		return true;
	}
	ignoreEvent() {
		return true;
	}
}

const decoField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decos, tr) {
		decos = decos.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(clearGroup)) {
				decos = decos.update({ filter: (_f, _t, d) => d.spec.group !== e.value });
			} else if (e.is(unhide)) {
				decos = decos.update({ filter: (_f, _t, d) => d.spec.hid !== e.value });
			} else if (e.is(showFeedbackEffect)) {
				const { pos, feedback } = e.value;
				const line = tr.state.doc.lineAt(pos);
				decos = decos.update({
					filter: (_f, _t, d) => d.spec.group !== "feedback",
					add: [Decoration.widget({ widget: new FeedbackWidget(feedback), block: true, side: 1, group: "feedback" }).range(line.to)],
					sort: true,
				});
			} else if (e.is(clearGap)) {
				decos = decos.update({ filter: (_f, _t, d) => !(d.spec.group === "gap" && d.spec.hid === e.value) });
			} else if (e.is(setGap)) {
				const { hid, from, to, width, shiftMs } = e.value;
				const widget = new GapWidget(width, shiftMs);
				const deco =
					to > from
						? Decoration.replace({ widget, group: "gap", hid }).range(from, to)
						: Decoration.widget({ widget, side: 1, group: "gap", hid }).range(from);
				decos = decos.update({ filter: (_f, _t, d) => !(d.spec.group === "gap" && d.spec.hid === hid), add: [deco], sort: true });
			} else if (e.is(addDecos)) {
				const ranges = e.value
					.filter((s) => s.to > s.from)
					.map((s) => {
						const attributes: Record<string, string> = {};
						if (s.style) attributes.style = s.style;
						return Decoration.mark({ class: s.cls, attributes, group: s.group, hid: s.hid }).range(s.from, s.to);
					});
				decos = decos.update({ add: ranges, sort: true });
			}
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

const lockField = StateField.define<boolean>({
	create: () => false,
	update(locked, tr) {
		for (const e of tr.effects) if (e.is(setLock)) locked = e.value;
		return locked;
	},
});

// While a rewrite is animating, drop user edits (typing, paste, undo...) so
// our position bookkeeping stays valid. Our own transactions carry no userEvent.
const lockFilter = EditorState.transactionFilter.of((tr) =>
	tr.docChanged && tr.startState.field(lockField, false) && tr.annotation(Transaction.userEvent) !== undefined
		? []
		: tr,
);

interface Controller {
	skip: boolean;
	wakers: Set<() => void>;
}
const controllers = new WeakMap<EditorView, Controller>();

const skipOnEscape = EditorView.domEventHandlers({
	keydown(event, view) {
		const ctl = controllers.get(view);
		if (!ctl || event.key !== "Escape") return false;
		skipAnimation(view);
		event.preventDefault();
		return true;
	},
});

export const proofreaderExtension: Extension = [decoField, lockField, lockFilter, skipOnEscape];

export function isAnimating(view: EditorView): boolean {
	return controllers.has(view);
}

/** Jump to the finished state of a running rewrite. */
export function skipAnimation(view: EditorView) {
	const ctl = controllers.get(view);
	if (!ctl) return;
	ctl.skip = true;
	for (const w of ctl.wakers) w();
}

export function markPending(view: EditorView, from: number, to: number) {
	view.dispatch({ effects: addDecos.of([{ from, to, group: "pending", cls: "np-pending" }]) });
}

export function clearPending(view: EditorView) {
	view.dispatch({ effects: clearGroup.of("pending") });
}

/** Puts the feedback card under the line containing `pos`; auto-hides after `ms` unless 0. */
export function showFeedback(view: EditorView, pos: number, feedback: Feedback, ms: number) {
	view.dispatch({ effects: showFeedbackEffect.of({ pos, feedback }) });
	if (ms > 0) {
		window.setTimeout(() => {
			// Only hide our own card; a newer one has replaced it if the widget differs.
			const still = view.state.field(decoField).iter();
			for (; still.value; still.next()) {
				if (still.value.spec.group === "feedback" && (still.value.spec.widget as FeedbackWidget).feedback === feedback) {
					hideFeedback(view);
					break;
				}
			}
		}, ms);
	}
}

export function hideFeedback(view: EditorView) {
	try {
		view.dispatch({ effects: clearGroup.of("feedback") });
	} catch {
		// Editor closed.
	}
}

/** "Checked, nothing to change": a brief light-blue flash over the passage. */
export function flashChecked(view: EditorView, from: number, to: number, params: AnimationParams) {
	if (params.flashMs <= 0) return;
	view.dispatch({ effects: addDecos.of([{ from, to, group: "flash", cls: "np-flash", style: `--np-flash:${params.flashMs}ms` }]) });
	window.setTimeout(() => {
		try {
			view.dispatch({ effects: clearGroup.of("flash") });
		} catch {
			// Editor closed.
		}
	}, params.flashMs);
}

/** Rendered width of a run of glyphs, or null when it wraps onto more than one line. */
function spanWidth(glyphs: Glyph[]): number | null {
	const first = glyphs[0];
	const last = glyphs[glyphs.length - 1];
	if (!first || first.top !== last.top) return null;
	return last.left + last.width - first.left;
}

function sleep(ms: number, ctl: Controller): Promise<void> {
	if (ctl.skip || ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = window.setTimeout(done, ms);
		function done() {
			window.clearTimeout(timer);
			ctl.wakers.delete(done);
			resolve();
		}
		ctl.wakers.add(done);
	});
}

/**
 * Replace `original` (starting at `from`) with `revised`. Each changed span
 * dissolves into particles while its replacement gathers out of them; the
 * whole thing lands in history as a single undoable edit.
 */
export async function animateRevision(
	view: EditorView,
	from: number,
	original: string,
	revised: string,
	hunks: Hunk[],
	params: AnimationParams,
	animate: boolean,
	/** What undo should restore; defaults to `original`. The demo passes "" so one undo removes its sample. */
	base: string = original,
): Promise<void> {
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const ctl: Controller = { skip: !animate || reduceMotion, wakers: new Set() };
	controllers.set(view, ctl);
	const noHistory = Transaction.addToHistory.of(false);
	// Length of the region being rewritten as swaps land, so the end is always known.
	let regionLen = original.length;
	const layer = ctl.skip ? null : new ParticleLayer(params);

	// Each phase (dissolve, gather) lasts L; the gather starts overlap*L into the dissolve.
	const phase = params.durationMs / (2 - params.overlap);
	const gatherAt = phase * (1 - params.overlap);

	// Absolute start offsets of every animated span in the original text: each changed
	// hunk, or the whole passage as one span.
	const changes: Array<{ id: number; hunk: Extract<Hunk, { type: "change" }>; at: number }> = [];
	if (params.scope === "passage") {
		changes.push({ id: 0, hunk: { type: "change", del: original, ins: revised }, at: 0 });
	} else {
		let pos = 0;
		for (const h of hunks) {
			if (h.type === "change") changes.push({ id: changes.length, hunk: h, at: pos });
			pos += h.type === "keep" ? h.text.length : h.del.length;
		}
	}
	// Swaps happen in document order (stagger >= 0), so a running shift is enough
	// to map original offsets to current positions.
	let shift = 0;

	const shiftMs = params.scope === "passage" ? 0 : Math.min(params.shiftMs, gatherAt);

	const runHunk = async ({ id, hunk, at }: (typeof changes)[number]) => {
		await sleep(id * params.staggerMs, ctl);
		if (ctl.skip || !layer) return;
		let oldWidth = 0;
		let font = "";
		if (hunk.del) {
			const s = from + at + shift;
			const glyphs = measureGlyphs(view, s, s + hunk.del.length);
			view.dispatch({ effects: addDecos.of([{ from: s, to: s + hunk.del.length, group: "hidden", cls: "np-hidden", hid: id }]) });
			layer.dissolve(glyphs, phase);
			font = glyphs[0]?.font ?? "";
			oldWidth = spanWidth(glyphs) ?? textWidth(hunk.del, font);
		}
		const singleLine = !hunk.del.includes("\n") && !hunk.ins.includes("\n");

		await sleep(gatherAt - shiftMs, ctl);
		if (ctl.skip) return;
		// Swap the text now, still hidden. Earlier hunks may have shifted it while we waited.
		const start = from + at + shift;
		view.dispatch({
			changes: { from: start, to: start + hunk.del.length, insert: hunk.ins },
			effects: [
				unhide.of(id),
				...(hunk.ins ? [addDecos.of([{ from: start, to: start + hunk.ins.length, group: "hidden", cls: "np-hidden", hid: id }])] : []),
			],
			annotations: noHistory,
		});
		shift += hunk.ins.length - hunk.del.length;
		regionLen += hunk.ins.length - hunk.del.length;
		let newGlyphs = hunk.ins ? measureGlyphs(view, start, start + hunk.ins.length) : [];

		if (singleLine && shiftMs > 0) {
			// Nothing has painted yet, so cover the new text with a box the old width and
			// ease it to the new text's real rendered width; the neighbours slide along.
			if (!font) font = newGlyphs[0]?.font ?? "";
			const newWidth = hunk.ins ? (spanWidth(newGlyphs) ?? textWidth(hunk.ins, font)) : 0;
			const gap = { hid: id, from: start, to: start + hunk.ins.length, shiftMs };
			view.dispatch({ effects: setGap.of({ ...gap, width: oldWidth }) });
			// Flush layout so the second width lands as a CSS transition, not a jump.
			// (A frame wait would do, but rAF stalls when the window is hidden.)
			void view.contentDOM.getBoundingClientRect();
			view.dispatch({ effects: setGap.of({ ...gap, width: newWidth }) });
			await sleep(shiftMs, ctl);
			if (ctl.skip) return;
			view.dispatch({ effects: clearGap.of(id) });
			if (hunk.ins) newGlyphs = measureGlyphs(view, start, start + hunk.ins.length);
		} else {
			await sleep(shiftMs, ctl);
			if (ctl.skip) return;
		}

		if (hunk.ins) {
			layer.gather(newGlyphs, phase);
			// Reveal the text while the particles are still (nearly) in place, then let them fade.
			const handoff = Math.min(0.9, Math.max(0, params.handoff));
			await sleep(phase * (1 - handoff), ctl);
			if (ctl.skip) return;
			view.dispatch({ effects: unhide.of(id) });
			await sleep(phase * handoff, ctl);
			if (ctl.skip) return;
		}
	};

	try {
		view.dispatch({ effects: setLock.of(true) });
		await Promise.all(changes.map(runHunk));
	} finally {
		controllers.delete(view);
		layer?.destroy();
		// Rewind the animated region to the original (outside history), then apply
		// the real edit once, so Ctrl+Z restores the passage in one step. Both
		// dispatches happen before the next paint, so nothing flickers. This also
		// completes the edit when the animation was skipped or interrupted.
		try {
			view.dispatch({
				changes: { from, to: from + regionLen, insert: base },
				effects: [setLock.of(false), clearGroup.of("hidden"), clearGroup.of("gap")],
				annotations: noHistory,
			});
			const marks: DecoSpec[] = [];
			const temporary = (params.mark === "underlay" || params.mark === "bold") && params.holdMs > 0;
			let p = from;
			for (const h of hunks) {
				const len = h.type === "keep" ? h.text.length : h.ins.length;
				if (h.type === "change" && len > 0 && temporary) {
					const cls = params.mark === "bold" ? "np-changed-bold" : "np-changed";
					marks.push({ from: p, to: p + len, group: "changed", cls, style: `--np-hold:${params.holdMs}ms` });
				}
				p += len;
			}
			view.dispatch({
				changes: { from, to: from + base.length, insert: revised },
				effects: addDecos.of(marks),
				userEvent: "input.proofread",
			});
			if (marks.length) {
				window.setTimeout(() => {
					try {
						view.dispatch({ effects: clearGroup.of("changed") });
					} catch {
						// The editor was closed in the meantime.
					}
				}, params.holdMs + 100);
			}
		} catch (e) {
			console.error("[note-proofreader] failed to finalize revision", e);
		}
	}
}

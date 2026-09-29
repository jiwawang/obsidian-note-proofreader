import { Editor, getLanguage, MarkdownFileInfo, MarkdownView, Menu, MenuItem, Notice, Plugin } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { animateRevision, clearPending, flashChecked, isAnimating, markPending, proofreaderExtension, showFeedback } from "./animation";
import { reviewPassage } from "./claude";
import { keepOuterWhitespace, ReviewError, ReviewInput, ReviewResult } from "./prompt";
import { reviewPassageOpenAI } from "./openai";
import { applyPermanentMark, computeHunks, joinRevised } from "./diff";
import { setLanguage, t } from "./i18n";
import { ExtraRequirementsModal } from "./modal";
import { DEFAULT_PARAMS } from "./params";
import { DEFAULT_SETTINGS, ProofreaderSettings, ProofreaderSettingTab } from "./settings";

const HIGHLIGHT_CLASSES = ["np-hl-gray", "np-hl-blue", "np-hl-theme"];

export default class NoteProofreaderPlugin extends Plugin {
	declare settings: ProofreaderSettings;
	private jobs = new Map<EditorView, AbortController>();
	private altTapAt = 0;
	private altAlone = false;

	async onload() {
		setLanguage(getLanguage());
		await this.loadSettings();
		this.applyHighlightColor();
		this.addSettingTab(new ProofreaderSettingTab(this.app, this));
		this.registerEditorExtension(proofreaderExtension);

		this.addCommand({
			id: "review",
			name: t().cmdReview,
			editorCheckCallback: (checking, editor, ctx) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) void this.run(editor, ctx, "");
				return true;
			},
		});
		this.addCommand({
			id: "review-with-requirements",
			name: t().cmdReviewExtra,
			editorCheckCallback: (checking, editor, ctx) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) void this.askAndRun(editor, ctx);
				return true;
			},
		});
		this.addCommand({
			id: "remove-highlights",
			name: t().cmdRemoveHighlights,
			editorCheckCallback: (checking, editor) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) this.removeHighlights(editor);
				return true;
			},
		});
		this.addCommand({
			id: "cancel",
			name: t().cmdCancel,
			editorCheckCallback: (checking, editor) => {
				const cm = cmOf(editor);
				const job = cm && this.jobs.get(cm);
				if (!job) return false;
				if (!checking) job.abort();
				return true;
			},
		});
		this.addCommand({
			id: "demo",
			name: t().cmdDemo,
			editorCallback: (editor) => void this.demo(editor),
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				if (!editor.somethingSelected()) return;
				// The menu shows just the brand ("Veritas Howler"), not the full "- Note Proofreader" name.
				const name = this.manifest.name.split(" - ")[0];
				menu.addItem((item) => {
					item.setTitle(name).setIcon("spell-check").setSection("selection");
					// setSubmenu exists at runtime but isn't in the public typings; fall back to flat items.
					const sub = (item as MenuItem & { setSubmenu?: () => Menu }).setSubmenu?.();
					const target = sub ?? menu;
					if (!sub) item.setTitle(`${name}${t().sep}${t().menuReview}`).onClick(() => void this.askAndRun(editor, ctx));
					else target.addItem((i) => i.setTitle(t().menuReview).setIcon("spell-check").onClick(() => void this.askAndRun(editor, ctx)));
					target.addItem((i) =>
						i
							.setTitle(sub ? t().menuRemoveHighlights : `${name}${t().sep}${t().menuRemoveHighlights}`)
							.setIcon("eraser")
							.setSection("selection")
							.onClick(() => this.removeHighlights(editor)),
					);
				});
			}),
		);

		// Double-tap Alt: two presses of Alt on its own within the configured interval.
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Alt") {
				if (!e.repeat) this.altAlone = true;
			} else {
				this.altAlone = false;
				this.altTapAt = 0;
			}
		});
		this.registerDomEvent(document, "keyup", (e) => {
			if (e.key !== "Alt") return;
			if (!this.altAlone || !this.settings.doubleAlt) return;
			const now = Date.now();
			if (now - this.altTapAt <= this.settings.doubleAltMs) {
				this.altTapAt = 0;
				this.reviewActiveSelection();
			} else {
				this.altTapAt = now;
			}
		});
	}

	onunload() {
		for (const job of this.jobs.values()) job.abort();
		document.body.classList.remove(...HIGHLIGHT_CLASSES);
	}

	/** Changed text is written as ==highlight==; this picks how highlights (and the waiting shimmer) look. */
	applyHighlightColor() {
		const cls = `np-hl-${this.settings.highlightColor}`;
		for (const c of HIGHLIGHT_CLASSES) document.body.classList.toggle(c, c === cls);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<ProofreaderSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		// 0.3.x had an on/off "light blue" switch, on by default. Off meant the theme's colour;
		// on (the old default) moves to the new default, gray.
		const legacy = saved as { blueHighlight?: boolean } | null;
		if (typeof legacy?.blueHighlight === "boolean" && !saved?.highlightColor) {
			this.settings.highlightColor = legacy.blueHighlight ? "gray" : "theme";
		}
		delete (this.settings as { blueHighlight?: boolean }).blueHighlight;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private reviewActiveSelection() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.editor.somethingSelected()) return;
		void this.run(view.editor, view, "");
	}

	private async askAndRun(editor: Editor, ctx: MarkdownView | MarkdownFileInfo) {
		const extra = await new ExtraRequirementsModal(this.app, this.settings.lastExtra).ask();
		if (extra === null) return;
		if (extra !== this.settings.lastExtra) {
			this.settings.lastExtra = extra;
			await this.saveSettings();
		}
		await this.run(editor, ctx, extra);
	}

	private async run(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, extra: string) {
		const cm = cmOf(editor);
		if (!cm) {
			new Notice(t().unsupportedEditor);
			return;
		}
		if (this.jobs.has(cm) || isAnimating(cm)) {
			new Notice(t().busy);
			return;
		}
		const secretId = this.settings.apiKeySecret;
		const apiKey = secretId ? this.app.secretStorage.getSecret(secretId) : null;
		if (!apiKey) {
			new Notice(t().needKey(this.manifest.name));
			return;
		}
		if (this.settings.provider === "openai" && (!this.settings.openaiBaseURL || !this.settings.openaiModel)) {
			new Notice(t().needEndpoint(this.manifest.name));
			return;
		}

		const sel = cm.state.selection.main;
		if (sel.empty) return;
		const { from, to } = sel;
		const doc = cm.state.doc.toString();
		const original = doc.slice(from, to);
		if (!original.trim()) return;

		const controller = new AbortController();
		this.jobs.set(cm, controller);
		markPending(cm, from, to);

		let result: ReviewResult;
		try {
			const input: ReviewInput = {
				noteTitle: ctx.file?.basename ?? "",
				doc,
				from,
				to,
				contextChars: this.settings.contextChars,
				extra,
			};
			result =
				this.settings.provider === "openai"
					? await reviewPassageOpenAI(this.settings, apiKey, input, controller.signal)
					: await reviewPassage(this.settings, apiKey, input, controller.signal);
		} catch (e) {
			new Notice(e instanceof ReviewError ? e.message : t().failed(String(e)), 8000);
			return;
		} finally {
			this.jobs.delete(cm);
			try {
				clearPending(cm);
			} catch {
				// The editor was closed while we waited.
			}
		}

		// The note may have been edited while Claude was working; find the passage again.
		const start = locate(cm.state.doc.toString(), original, from);
		if (start < 0) {
			new Notice(t().changedWhileWaiting, 6000);
			return;
		}
		let revised = keepOuterWhitespace(original, result.revised);
		const ms = this.settings.feedbackSeconds * 1000;
		if (revised === original) {
			flashChecked(cm, start, start + original.length, DEFAULT_PARAMS);
			showFeedback(cm, start + original.length, { kind: "ok", title: t().cardOk, body: result.explanation }, ms);
			return;
		}
		const hunks = applyPermanentMark(computeHunks(original, revised), DEFAULT_PARAMS.mark);
		revised = joinRevised(hunks);
		const changes = hunks.filter((h) => h.type === "change").length;
		await animateRevision(cm, start, original, revised, hunks, DEFAULT_PARAMS, this.settings.animate);
		showFeedback(cm, start + revised.length, { kind: "fixed", title: t().cardFixed(changes), body: result.explanation }, ms);
	}

	/** Strips ==highlight== markers inside the selection, as one undoable edit. */
	private removeHighlights(editor: Editor) {
		const text = editor.getSelection();
		const cleaned = text.replace(/==([^=\n]+?)==/g, "$1");
		if (cleaned === text) {
			new Notice(t().noHighlights);
			return;
		}
		editor.replaceSelection(cleaned);
	}

	/** Inserts a sample passage and plays its correction; one Ctrl+Z removes both. */
	private async demo(editor: Editor) {
		const cm = cmOf(editor);
		if (!cm || isAnimating(cm)) return;
		const head = cm.state.selection.main.head;
		const line = cm.state.doc.lineAt(head);
		const at = line.to;
		const prefix = line.text ? "\n\n" : "";
		const original = prefix + t().demoOriginal;
		// Inserted outside history so the final edit in animateRevision restores an empty region on undo.
		cm.dispatch({ changes: { from: at, insert: original }, annotations: Transaction.addToHistory.of(false) });
		markPending(cm, at + prefix.length, at + original.length);
		await new Promise((r) => window.setTimeout(r, 1500));
		clearPending(cm);
		const hunks = applyPermanentMark(computeHunks(original, prefix + t().demoRevised), DEFAULT_PARAMS.mark);
		await animateRevision(cm, at, original, joinRevised(hunks), hunks, DEFAULT_PARAMS, this.settings.animate, "");
	}
}

function cmOf(editor: Editor): EditorView | undefined {
	// Obsidian's Editor wraps a CodeMirror 6 EditorView but doesn't type it.
	return (editor as unknown as { cm?: EditorView }).cm;
}

/** Position of `text` in `doc`, preferring the occurrence closest to `hint`; -1 if gone. */
function locate(doc: string, text: string, hint: number): number {
	if (doc.startsWith(text, hint)) return hint;
	let best = -1;
	for (let i = doc.indexOf(text); i >= 0; i = doc.indexOf(text, i + 1)) {
		if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
	}
	return best;
}

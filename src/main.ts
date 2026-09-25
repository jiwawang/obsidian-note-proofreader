import { Editor, MarkdownFileInfo, MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { animateRevision, clearPending, flashChecked, isAnimating, markPending, proofreaderExtension } from "./animation";
import { ReviewError, reviewPassage } from "./claude";
import { reviewPassageOpenAI } from "./openai";
import { applyPermanentMark, computeHunks, joinRevised } from "./diff";
import { ExtraRequirementsModal } from "./modal";
import { DEFAULT_PARAMS } from "./params";
import { DEFAULT_SETTINGS, ProofreaderSettings, ProofreaderSettingTab } from "./settings";

const DEMO_ORIGINAL = "光合作用是植物在夜晚把二氧化碳转化为氧气的过程，主要发生在线粒体里。说白了就是植物吃阳光。";
const DEMO_REVISED = "光合作用是植物在光照下把二氧化碳和水转化为有机物并放出氧气的过程，主要发生在叶绿体里。说白了就是植物吃阳光。";

export default class NoteProofreaderPlugin extends Plugin {
	declare settings: ProofreaderSettings;
	private jobs = new Map<EditorView, AbortController>();
	private altTapAt = 0;
	private altAlone = false;

	async onload() {
		await this.loadSettings();
		this.applyHighlightColor();
		this.addSettingTab(new ProofreaderSettingTab(this.app, this));
		this.registerEditorExtension(proofreaderExtension);

		this.addCommand({
			id: "review",
			name: "审阅修改（仅事实错误）",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) void this.run(editor, ctx, "");
				return true;
			},
		});
		this.addCommand({
			id: "review-with-requirements",
			name: "审阅修改（填写额外要求）",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!editor.somethingSelected()) return false;
				if (!checking) void this.askAndRun(editor, ctx);
				return true;
			},
		});
		this.addCommand({
			id: "cancel",
			name: "取消正在进行的审阅",
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
			name: "演示动画（不调用 API）",
			editorCallback: (editor) => void this.demo(editor),
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				if (!editor.somethingSelected()) return;
				menu.addItem((item) =>
					item
						.setTitle("审阅修改")
						.setIcon("spell-check")
						.setSection("selection")
						.onClick(() => void this.askAndRun(editor, ctx)),
				);
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
		document.body.classList.remove("np-blue-highlight");
	}

	/** Changed text is written as ==highlight==; this recolours highlights light blue to match. */
	applyHighlightColor() {
		document.body.classList.toggle("np-blue-highlight", this.settings.blueHighlight);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
			new Notice("当前编辑器不受支持。");
			return;
		}
		if (this.jobs.has(cm) || isAnimating(cm)) {
			new Notice("这篇笔记正在处理中，请稍候。");
			return;
		}
		const secretId = this.settings.apiKeySecret;
		const apiKey = secretId ? this.app.secretStorage.getSecret(secretId) : null;
		if (!apiKey) {
			new Notice("请先在「Note Proofreader」设置中配置 API Key。");
			return;
		}
		if (this.settings.provider === "openai" && (!this.settings.openaiBaseURL || !this.settings.openaiModel)) {
			new Notice("请先在「Note Proofreader」设置中填写接口地址和模型 ID。");
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

		let revised: string;
		try {
			const input = {
				passage: original,
				context: buildContext(doc, from, to, this.settings.contextChars),
				noteTitle: ctx.file?.basename ?? "",
				extra,
			};
			revised =
				this.settings.provider === "openai"
					? await reviewPassageOpenAI(this.settings, apiKey, input, controller.signal)
					: await reviewPassage(this.settings, apiKey, input, controller.signal);
		} catch (e) {
			new Notice(e instanceof ReviewError ? e.message : `出错了：${String(e)}`, 8000);
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
			new Notice("原文在等待期间被改动，这次的结果没有应用。", 6000);
			return;
		}
		revised = keepOuterWhitespace(original, revised);
		if (revised === original) {
			flashChecked(cm, start, start + original.length, DEFAULT_PARAMS);
			return;
		}
		const hunks = applyPermanentMark(computeHunks(original, revised), DEFAULT_PARAMS.mark);
		revised = joinRevised(hunks);
		await animateRevision(cm, start, original, revised, hunks, DEFAULT_PARAMS, this.settings.animate);
	}

	/** Inserts a sample passage and plays its correction; one Ctrl+Z removes both. */
	private async demo(editor: Editor) {
		const cm = cmOf(editor);
		if (!cm || isAnimating(cm)) return;
		const head = cm.state.selection.main.head;
		const line = cm.state.doc.lineAt(head);
		const at = line.to;
		const prefix = line.text ? "\n\n" : "";
		const original = prefix + DEMO_ORIGINAL;
		// Inserted outside history so the final edit in animateRevision restores an empty region on undo.
		cm.dispatch({ changes: { from: at, insert: original }, annotations: Transaction.addToHistory.of(false) });
		markPending(cm, at + prefix.length, at + original.length);
		await new Promise((r) => window.setTimeout(r, 1500));
		clearPending(cm);
		const hunks = applyPermanentMark(computeHunks(original, prefix + DEMO_REVISED), DEFAULT_PARAMS.mark);
		await animateRevision(cm, at, original, joinRevised(hunks), hunks, DEFAULT_PARAMS, this.settings.animate, "");
	}
}

function cmOf(editor: Editor): EditorView | undefined {
	// Obsidian's Editor wraps a CodeMirror 6 EditorView but doesn't type it.
	return (editor as unknown as { cm?: EditorView }).cm;
}

/** The note text with the passage wrapped in <selection>, trimmed to about maxChars around it. */
function buildContext(doc: string, from: number, to: number, maxChars: number): string {
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

/** Models tend to trim or add edge whitespace; keep the selection's own so it fits back in. */
function keepOuterWhitespace(original: string, revised: string): string {
	if (!revised.trim()) return original;
	const lead = original.match(/^\s*/)![0];
	const trail = original.match(/\s*$/)![0];
	return lead + revised.trim() + trail;
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

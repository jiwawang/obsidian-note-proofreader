import { App, PluginSettingTab, SecretComponent, Setting, TextAreaComponent } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { t } from "./i18n";
import { listClaudeModels } from "./claude";
import { listModels } from "./openai";
import { DEFAULT_RULES } from "./prompt";
import type NoteProofreaderPlugin from "./main";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Provider = "anthropic" | "openai";

/** How ==highlights== (and the waiting shimmer) look. */
export type HighlightColor = "gray" | "blue" | "theme";

export interface ProofreaderSettings {
	provider: Provider;
	/** ID of the secret in Obsidian's keychain that holds the API key of the selected provider. */
	apiKeySecret: string;
	/** Anthropic: custom base URL (empty = official). */
	baseURL: string;
	/** Anthropic model. */
	model: string;
	/** OpenAI-compatible endpoint (chat/completions is appended) and model. */
	openaiBaseURL: string;
	openaiModel: string;
	effort: Effort;
	useFallbacks: boolean;
	contextChars: number;
	doubleAlt: boolean;
	doubleAltMs: number;
	animate: boolean;
	highlightColor: HighlightColor;
	/** Whether the feedback card hides by itself; off = it stays until closed with ×. */
	feedbackAutoHide: boolean;
	/** With auto-hide on: how long the card stays, seconds. */
	feedbackSeconds: number;
	/** Last "extra requirements" text, pre-filled next time. */
	lastExtra: string;
	/** The user's own review rules replacing the built-in prompt; empty = built-in. */
	customPrompt: string;
}

export const DEFAULT_SETTINGS: ProofreaderSettings = {
	provider: "openai",
	apiKeySecret: "",
	baseURL: "",
	model: "claude-opus-5",
	openaiBaseURL: "https://api.deepseek.com",
	openaiModel: "deepseek-flash",
	effort: "high",
	useFallbacks: true,
	contextChars: 20000,
	doubleAlt: true,
	doubleAltMs: 300,
	animate: true,
	highlightColor: "gray",
	feedbackAutoHide: true,
	feedbackSeconds: 20,
	lastExtra: "",
	customPrompt: "",
};

/** Ready-made OpenAI-compatible endpoints. Base URL + a cheap default model. */
export const OPENAI_PRESETS: Record<string, { name: string; baseURL: string; model: string; hint: () => string }> = {
	deepseek: {
		name: "DeepSeek",
		baseURL: "https://api.deepseek.com",
		model: "deepseek-flash",
		hint: () => t().presetDeepseek,
	},
	gemini: {
		name: "Google Gemini",
		baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
		model: "gemini-2.5-flash-lite",
		hint: () => t().presetGemini,
	},
	openrouter: {
		name: "OpenRouter",
		baseURL: "https://openrouter.ai/api/v1",
		model: "openrouter/free",
		hint: () => t().presetOpenRouter,
	},
	custom: { name: "Custom…", baseURL: "", model: "", hint: () => t().presetCustom },
};

/**
 * Claude models offered before the key can list the real ones (a function, so the labels
 * follow the language picked on load).
 */
const claudeShortlist = (): ModelEntry[] => [
	{ id: "claude-opus-5", label: t().opusRecommended },
	{ id: "claude-sonnet-5", label: t().sonnet },
	{ id: "claude-haiku-4-5", label: t().haiku },
];

/** Which preset the current OpenAI-compatible base URL matches, or "custom". */
function presetOf(s: ProofreaderSettings): string {
	return Object.entries(OPENAI_PRESETS).find(([id, p]) => id !== "custom" && p.baseURL === s.openaiBaseURL)?.[0] ?? "custom";
}

/** Dropdown value that switches the model row to a free-text field. */
const CUSTOM_MODEL = "__custom__";

interface ModelEntry {
	id: string;
	label: string;
}

/** The provider's model list as last fetched; `sig` ties it to the provider, endpoint and key. */
interface Catalog {
	sig: string;
	status: "loading" | "ok" | "error";
	models: ModelEntry[];
	error?: string;
}

export class ProofreaderSettingTab extends PluginSettingTab {
	/** The model row shows a free-text field instead of the list. */
	private typingModelId = false;
	private catalog: Catalog | null = null;

	constructor(
		app: App,
		private plugin: NoteProofreaderPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const openai = () => s.provider === "openai";
		const anthropic = () => s.provider === "anthropic";

		return [
			{
				type: "group",
				heading: t().hModel,
				items: [
					{
						name: t().provider,
						control: {
							type: "dropdown",
							key: "provider",
							options: { openai: t().providerOpenAI, anthropic: "Anthropic Claude" },
						},
					},
					{
						name: t().preset,
						desc: OPENAI_PRESETS[presetOf(s)].hint(),
						visible: openai,
						control: {
							type: "dropdown",
							key: "preset",
							options: Object.fromEntries(Object.entries(OPENAI_PRESETS).map(([id, p]) => [id, id === "custom" ? t().custom : p.name])),
						},
					},
					{
						name: t().endpoint,
						desc: t().endpointDesc,
						visible: openai,
						control: { type: "text", key: "openaiBaseURL", placeholder: "https://api.example.com/v1" },
					},
					{
						name: t().model,
						render: (setting) => this.renderModel(setting),
					},
					{
						name: "API key",
						desc:
							s.provider === "anthropic"
								? t().keyDescAnthropic
								: t().keyDescOpenAI,
						render: (setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (v) => {
									s.apiKeySecret = v;
									await this.plugin.saveSettings();
									// A new key may unlock the provider's model list.
									this.update();
								}),
							);
						},
					},
					{
						name: t().effort,
						desc: t().effortDesc,
						visible: anthropic,
						control: {
							type: "dropdown",
							key: "effort",
							options: { low: "low", medium: "medium", high: t().effortDefault, xhigh: "xhigh", max: "max" },
						},
					},
					{
						name: t().fallbacks,
						desc: t().fallbacksDesc,
						visible: anthropic,
						control: { type: "toggle", key: "useFallbacks" },
					},
					{
						name: t().customApi,
						desc: t().customApiDesc,
						visible: anthropic,
						control: { type: "text", key: "baseURL", placeholder: "https://api.anthropic.com" },
					},
					{
						name: t().context,
						desc: t().contextDesc,
						control: {
							type: "number",
							key: "contextChars",
							min: 0,
							step: 1000,
							validate: (v) => (Number.isFinite(v) && v >= 0 ? undefined : t().contextInvalid),
						},
					},
				],
			},
			{
				type: "group",
				heading: t().hPrompt,
				items: [
					{
						name: t().customPrompt,
						desc: t().customPromptDesc,
						render: (setting) => this.renderCustomPrompt(setting),
					},
				],
			},
			{
				type: "group",
				heading: t().hTrigger,
				items: [
					{
						name: t().doubleAlt,
						desc: t().doubleAltDesc,
						control: { type: "toggle", key: "doubleAlt" },
					},
					{
						name: t().doubleAltMs,
						control: { type: "slider", key: "doubleAltMs", min: 150, max: 600, step: 25 },
					},
					{
						name: t().feedbackAutoHide,
						desc: t().feedbackAutoHideDesc,
						control: { type: "toggle", key: "feedbackAutoHide" },
					},
					{
						name: t().feedbackTime,
						visible: () => s.feedbackAutoHide,
						control: {
							type: "slider",
							key: "feedbackSeconds",
							min: 5,
							max: 60,
							step: 5,
							displayFormat: (v) => t().seconds(v),
						},
					},
					{
						name: t().highlight,
						desc: t().highlightDesc,
						control: { type: "dropdown", key: "highlightColor", options: { gray: t().hlGray, blue: t().hlBlue, theme: t().hlTheme } },
					},
					{
						name: t().animate,
						desc: t().animateDesc,
						control: { type: "toggle", key: "animate" },
					},
				],
			},
		];
	}

	/**
	 * The custom prompt: a full-width editor. Empty means the built-in prompt; the buttons load
	 * the built-in rules for editing, or clear back to them.
	 */
	private renderCustomPrompt(setting: Setting) {
		const s = this.plugin.settings;
		setting.settingEl.addClass("np-prompt-setting");
		let area: TextAreaComponent | null = null;
		setting.addTextArea((text) => {
			area = text;
			text.inputEl.rows = 14;
			text
				.setPlaceholder(t().customPromptPlaceholder)
				.setValue(s.customPrompt)
				.onChange(async (v) => {
					s.customPrompt = v;
					await this.plugin.saveSettings();
				});
		});
		setting.addExtraButton((b) =>
			b
				.setIcon("file-text")
				.setTooltip(t().customPromptLoad)
				.onClick(async () => {
					s.customPrompt = DEFAULT_RULES;
					area?.setValue(DEFAULT_RULES);
					await this.plugin.saveSettings();
				}),
		);
		setting.addExtraButton((b) =>
			b
				.setIcon("rotate-ccw")
				.setTooltip(t().customPromptReset)
				.onClick(async () => {
					s.customPrompt = "";
					area?.setValue("");
					await this.plugin.saveSettings();
				}),
		);
	}

	/**
	 * The model row, for either provider: a dropdown of the models the provider lists for this
	 * key (OpenAI-compatible: GET {base}/models; Claude: the Models API), falling back to Claude's
	 * shortlist or a text field. "Custom…" switches to typing an ID; a button reloads the list.
	 */
	private renderModel(setting: Setting) {
		const s = this.plugin.settings;
		const claude = s.provider === "anthropic";
		const current = claude ? s.model : s.openaiModel;
		const save = async (v: string) => {
			if (claude) s.model = v || DEFAULT_SETTINGS.model;
			else s.openaiModel = v;
			await this.plugin.saveSettings();
		};
		const c = this.loadCatalog();
		let desc: string;
		if (!c) desc = claude ? t().claudeModelsNeedKey : t().modelsNeedKey;
		else if (c.status === "loading") desc = t().modelsLoading;
		else if (c.status === "error") desc = t().modelsFailed(c.error ?? "");
		else desc = t().modelsFound(c.models.length);
		setting.setDesc(desc);

		const listed = c?.status === "ok" ? c.models : claude ? claudeShortlist() : [];
		if (listed.length && !this.typingModelId) {
			const options: Record<string, string> = {};
			if (current && !listed.some((m) => m.id === current)) options[current] = t().modelCurrent(current);
			for (const m of listed) options[m.id] = m.label;
			options[CUSTOM_MODEL] = t().modelCustom;
			setting.addDropdown((d) =>
				d
					.addOptions(options)
					.setValue(current || listed[0].id)
					.onChange(async (v) => {
						if (v === CUSTOM_MODEL) {
							this.typingModelId = true;
							this.update();
							return;
						}
						await save(v);
					}),
			);
		} else {
			setting.addText((text) =>
				text
					.setPlaceholder(claude ? DEFAULT_SETTINGS.model : OPENAI_PRESETS[presetOf(s)].model || "model-id")
					.setValue(current)
					.onChange(async (v) => save(v.trim())),
			);
		}
		setting.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip(t().modelsRefresh)
				.onClick(() => {
					this.typingModelId = false;
					this.loadCatalog(true);
					this.update();
				}),
		);
	}

	/**
	 * The model list for the current provider, endpoint and key, fetching it if it's missing or
	 * stale. Null when there's nothing to ask yet (no endpoint, or no key where one is needed).
	 */
	private loadCatalog(force = false): Catalog | null {
		const s = this.plugin.settings;
		const claude = s.provider === "anthropic";
		const base = claude ? s.baseURL.trim() : s.openaiBaseURL;
		const key = s.apiKeySecret ? (this.app.secretStorage.getSecret(s.apiKeySecret) ?? "") : "";
		// OpenRouter lists its models publicly; everyone else wants a key.
		const needsKey = claude || presetOf(s) !== "openrouter";
		if ((!claude && !base) || (needsKey && !key)) return (this.catalog = null);
		const sig = [s.provider, base, key].join("\n");
		if (!force && this.catalog?.sig === sig) return this.catalog;
		const catalog: Catalog = { sig, status: "loading", models: [] };
		this.catalog = catalog;
		const request: Promise<ModelEntry[]> = claude
			? listClaudeModels(key, base)
			: listModels(base, key).then((ids) => ids.map((id) => ({ id, label: id })));
		request.then(
			(models) => {
				if (this.catalog !== catalog) return;
				this.catalog = models.length ? { sig, status: "ok", models } : { sig, status: "error", models, error: t().noResult };
				this.update();
			},
			(e: unknown) => {
				if (this.catalog !== catalog) return;
				this.catalog = { sig, status: "error", models: [], error: e instanceof Error ? e.message : String(e) };
				this.update();
			},
		);
		return catalog;
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key === "preset") return presetOf(s);
		return (s as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		// Some choices reveal or hide other rows, so the tab re-reads its definitions afterwards.
		let rebuild = false;
		if (key === "preset") {
			const preset = OPENAI_PRESETS[String(value)];
			if (preset && value !== "custom") {
				s.openaiBaseURL = preset.baseURL;
				s.openaiModel = preset.model;
			} else {
				s.openaiBaseURL = "";
			}
			this.typingModelId = false;
			rebuild = true;
		} else {
			let v = value;
			if (typeof v === "string") v = v.trim();
			if (key === "openaiBaseURL" && typeof v === "string") v = v.replace(/\/+$/, "");
			if (key === "model" && !v) v = DEFAULT_SETTINGS.model;
			(s as unknown as Record<string, unknown>)[key] = v;
			if (key === "provider") this.typingModelId = false;
			rebuild = key === "provider" || key === "feedbackAutoHide";
		}
		await this.plugin.saveSettings();
		if (key === "highlightColor") this.plugin.applyHighlightColor();
		if (rebuild) this.update();
	}
}

import { App, PluginSettingTab, SecretComponent } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { t } from "./i18n";
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
	/** How long the feedback note stays on screen, seconds; 0 = until clicked. */
	feedbackSeconds: number;
	/** Last "extra requirements" text, pre-filled next time. */
	lastExtra: string;
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
	feedbackSeconds: 20,
	lastExtra: "",
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

/** Anthropic model choices (a function, so labels follow the language picked on load). */
const modelOptions = (): Record<string, string> => ({
	"claude-opus-5": t().opusRecommended,
	"claude-sonnet-5": t().sonnet,
	"claude-haiku-4-5": t().haiku,
	custom: t().custom,
});

/** Which preset the current OpenAI-compatible base URL matches, or "custom". */
function presetOf(s: ProofreaderSettings): string {
	return Object.entries(OPENAI_PRESETS).find(([id, p]) => id !== "custom" && p.baseURL === s.openaiBaseURL)?.[0] ?? "custom";
}

export class ProofreaderSettingTab extends PluginSettingTab {
	private editingCustomModel = false;

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
		const customModel = () => anthropic() && (this.editingCustomModel || !(s.model in modelOptions()));

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
								}),
							);
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
						name: t().modelId,
						visible: openai,
						control: { type: "text", key: "openaiModel", placeholder: "deepseek-flash" },
					},
					{
						name: t().model,
						visible: anthropic,
						control: { type: "dropdown", key: "modelChoice", options: modelOptions() },
					},
					{
						name: t().customModelId,
						visible: customModel,
						control: { type: "text", key: "model", placeholder: "claude-opus-5" },
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
						name: t().feedbackTime,
						desc: t().feedbackTimeDesc,
						control: {
							type: "slider",
							key: "feedbackSeconds",
							min: 0,
							max: 60,
							step: 5,
							displayFormat: (v) => (v === 0 ? t().feedbackForever : t().seconds(v)),
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

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key === "preset") return presetOf(s);
		if (key === "modelChoice") return this.editingCustomModel || !(s.model in modelOptions()) ? "custom" : s.model;
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
			rebuild = true;
		} else if (key === "modelChoice") {
			this.editingCustomModel = value === "custom";
			if (value !== "custom") s.model = String(value);
			rebuild = true;
		} else {
			let v = value;
			if (typeof v === "string") v = v.trim();
			if (key === "openaiBaseURL" && typeof v === "string") v = v.replace(/\/+$/, "");
			if (key === "model" && !v) v = DEFAULT_SETTINGS.model;
			(s as unknown as Record<string, unknown>)[key] = v;
			rebuild = key === "provider";
		}
		await this.plugin.saveSettings();
		if (key === "highlightColor") this.plugin.applyHighlightColor();
		if (rebuild) this.update();
	}
}

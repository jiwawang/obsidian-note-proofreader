import { App, PluginSettingTab, SecretComponent } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type NoteProofreaderPlugin from "./main";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Provider = "anthropic" | "openai";

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
	/** Show ==highlights== in light blue instead of the theme's colour. */
	blueHighlight: boolean;
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
	blueHighlight: true,
	feedbackSeconds: 20,
	lastExtra: "",
};

/** Ready-made OpenAI-compatible endpoints. Base URL + a cheap default model. */
export const OPENAI_PRESETS: Record<string, { name: string; baseURL: string; model: string; hint: string }> = {
	deepseek: {
		name: "DeepSeek",
		baseURL: "https://api.deepseek.com",
		model: "deepseek-flash",
		hint: "Key 在 platform.deepseek.com 创建。约 $0.15–0.30 / 百万输入 token；也可填 deepseek-v4-pro（更强，约 3 倍价）。",
	},
	gemini: {
		name: "Google Gemini",
		baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
		model: "gemini-2.5-flash-lite",
		hint: "Key 在 aistudio.google.com 创建，Flash 系列有免费额度（免费档数据可能被用于训练）。更强可填 gemini-3.8-flash。",
	},
	openrouter: {
		name: "OpenRouter",
		baseURL: "https://openrouter.ai/api/v1",
		model: "openrouter/free",
		hint: "Key 在 openrouter.ai 创建。openrouter/free 随机路由到免费模型（质量不稳定）；也可填任意模型 ID，如 deepseek/deepseek-flash。",
	},
	custom: { name: "自定义…", baseURL: "", model: "", hint: "任何 OpenAI 兼容接口：填 /v1 结尾的地址（不含 /chat/completions）和模型 ID。" },
};

const MODEL_OPTIONS: Record<string, string> = {
	"claude-opus-5": "Claude Opus 5（推荐）",
	"claude-sonnet-5": "Claude Sonnet 5（更快、更便宜）",
	"claude-haiku-4-5": "Claude Haiku 4.5（最快）",
	custom: "自定义…",
};

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
		const customModel = () => anthropic() && (this.editingCustomModel || !(s.model in MODEL_OPTIONS));

		return [
			{
				type: "group",
				heading: "模型服务",
				items: [
					{
						name: "服务商",
						control: {
							type: "dropdown",
							key: "provider",
							options: { openai: "OpenAI 兼容接口（DeepSeek / Gemini / OpenRouter…）", anthropic: "Anthropic Claude" },
						},
					},
					{
						name: "API key",
						desc:
							s.provider === "anthropic"
								? "保存在 Obsidian 的密钥库中，不会写进仓库文件。在 console.anthropic.com 创建。"
								: "所选服务商的 API key，保存在 Obsidian 的密钥库中，不会写进仓库文件。",
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
						name: "预设",
						desc: OPENAI_PRESETS[presetOf(s)].hint,
						visible: openai,
						control: {
							type: "dropdown",
							key: "preset",
							options: Object.fromEntries(Object.entries(OPENAI_PRESETS).map(([id, p]) => [id, p.name])),
						},
					},
					{
						name: "接口地址",
						desc: "OpenAI 兼容的 base URL，插件会在后面加上 /chat/completions。",
						visible: openai,
						control: { type: "text", key: "openaiBaseURL", placeholder: "https://api.example.com/v1" },
					},
					{
						name: "模型 ID",
						visible: openai,
						control: { type: "text", key: "openaiModel", placeholder: "deepseek-flash" },
					},
					{
						name: "模型",
						visible: anthropic,
						control: { type: "dropdown", key: "modelChoice", options: MODEL_OPTIONS },
					},
					{
						name: "自定义模型 ID",
						visible: customModel,
						control: { type: "text", key: "model", placeholder: "claude-opus-5" },
					},
					{
						name: "思考强度 (effort)",
						desc: "越高查验越仔细，但更慢、更贵。Haiku 不支持此项。",
						visible: anthropic,
						control: {
							type: "dropdown",
							key: "effort",
							options: { low: "low", medium: "medium", high: "high（默认）", xhigh: "xhigh", max: "max" },
						},
					},
					{
						name: "拒答时自动换用备用模型",
						desc: "Opus 5 的安全分类器偶尔会误拒正常内容，开启后由服务端自动改用推荐的备用模型重试。使用自定义代理地址时若报错可关闭。",
						visible: anthropic,
						control: { type: "toggle", key: "useFallbacks" },
					},
					{
						name: "自定义 API 地址",
						desc: "留空使用官方地址 https://api.anthropic.com。",
						visible: anthropic,
						control: { type: "text", key: "baseURL", placeholder: "https://api.anthropic.com" },
					},
					{
						name: "参考上下文长度",
						desc: "随选区一起发送、供模型理解前后文的笔记字符数。笔记更短时发送全文。",
						control: {
							type: "number",
							key: "contextChars",
							min: 0,
							step: 1000,
							validate: (v) => (Number.isFinite(v) && v >= 0 ? undefined : "请输入不小于 0 的数字。"),
						},
					},
				],
			},
			{
				type: "group",
				heading: "触发与动画",
				items: [
					{
						name: "双击 Alt / Option (⌥) 审阅选中文字",
						desc: "连续按两次 Alt（Mac 上是 Option ⌥，中间不按其他键）直接修正选区内的事实性错误。也可以在「快捷键」里给「审阅修改」命令另外绑键。",
						control: { type: "toggle", key: "doubleAlt" },
					},
					{
						name: "双击间隔（毫秒）",
						control: { type: "slider", key: "doubleAltMs", min: 150, max: 600, step: 25 },
					},
					{
						name: "反馈卡片停留时间",
						desc: "审阅结束后，这段文字下方的反馈卡片显示多久；0 = 一直显示，点右上角 × 关闭。",
						control: {
							type: "slider",
							key: "feedbackSeconds",
							min: 0,
							max: 60,
							step: 5,
							displayFormat: (v) => (v === 0 ? "一直显示" : `${v} 秒`),
						},
					},
					{
						name: "高亮显示为浅蓝",
						desc: "改动处会以 ==高亮== 语法写入笔记。开启后笔记里所有高亮都显示为浅蓝色，而不是主题默认的黄色。",
						control: { type: "toggle", key: "blueHighlight" },
					},
					{
						name: "颗粒动画",
						desc: "改动的文字散成颗粒再重新聚成新文字。动画中按 Esc 可跳过；系统开启“减少动态效果”时自动关闭。",
						control: { type: "toggle", key: "animate" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key === "preset") return presetOf(s);
		if (key === "modelChoice") return this.editingCustomModel || !(s.model in MODEL_OPTIONS) ? "custom" : s.model;
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
		if (key === "blueHighlight") this.plugin.applyHighlightColor();
		if (rebuild) this.update();
	}
}

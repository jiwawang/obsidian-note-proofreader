import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
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

export class ProofreaderSettingTab extends PluginSettingTab {
	private editingCustomModel = false;

	constructor(
		app: App,
		private plugin: NoteProofreaderPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("模型服务").setHeading();

		new Setting(containerEl)
			.setName("服务商")
			.addDropdown((d) =>
				d
					.addOptions({ openai: "OpenAI 兼容接口（DeepSeek / Gemini / OpenRouter…）", anthropic: "Anthropic Claude" })
					.setValue(s.provider)
					.onChange(async (v) => {
						s.provider = v as Provider;
						await save();
						this.display();
					}),
			);

		const keyDesc =
			s.provider === "anthropic"
				? "保存在 Obsidian 的密钥库中，不会写进仓库文件。在 console.anthropic.com 创建。"
				: "所选服务商的 API Key，保存在 Obsidian 的密钥库中，不会写进仓库文件。";
		new Setting(containerEl)
			.setName("API Key")
			.setDesc(keyDesc)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (v) => {
					s.apiKeySecret = v;
					await save();
				}),
			);

		if (s.provider === "openai") this.displayOpenAI(containerEl);
		else this.displayAnthropic(containerEl);

		new Setting(containerEl)
			.setName("参考上下文长度")
			.setDesc("随选区一起发送、供 Claude 理解前后文的笔记字符数。笔记更短时发送全文。")
			.addText((t) =>
				t.setValue(String(s.contextChars)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n >= 0) {
						s.contextChars = n;
						await save();
					}
				}),
			);

		new Setting(containerEl).setName("触发与动画").setHeading();

		new Setting(containerEl)
			.setName("双击 Alt 审阅选中文字")
			.setDesc("连续按两次 Alt（中间不按其他键）直接修正选区内的事实性错误。也可以在「快捷键」里给「审阅修改」命令另外绑键。")
			.addToggle((t) =>
				t.setValue(s.doubleAlt).onChange(async (v) => {
					s.doubleAlt = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("双击间隔（毫秒）")
			.addSlider((sl) =>
				sl
					.setLimits(150, 600, 25)
					.setValue(s.doubleAltMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.doubleAltMs = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("高亮显示为浅蓝")
			.setDesc("改动处会以 ==高亮== 语法写入笔记。开启后笔记里所有高亮都显示为浅蓝色，而不是主题默认的黄色。")
			.addToggle((t) =>
				t.setValue(s.blueHighlight).onChange(async (v) => {
					s.blueHighlight = v;
					await save();
					this.plugin.applyHighlightColor();
				}),
			);

		new Setting(containerEl)
			.setName("颗粒动画")
			.setDesc("改动的词句散成颗粒再重新聚成新文字。动画中按 Esc 可跳过；系统开启“减少动态效果”时自动关闭。")
			.addToggle((t) =>
				t.setValue(s.animate).onChange(async (v) => {
					s.animate = v;
					await save();
				}),
			);
	}

	private displayOpenAI(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const presetOf = () =>
			Object.entries(OPENAI_PRESETS).find(([id, p]) => id !== "custom" && p.baseURL === s.openaiBaseURL)?.[0] ?? "custom";
		const preset = presetOf();

		new Setting(containerEl)
			.setName("预设")
			.setDesc(OPENAI_PRESETS[preset].hint)
			.addDropdown((d) =>
				d
					.addOptions(Object.fromEntries(Object.entries(OPENAI_PRESETS).map(([id, p]) => [id, p.name])))
					.setValue(preset)
					.onChange(async (v) => {
						if (v !== "custom") {
							s.openaiBaseURL = OPENAI_PRESETS[v].baseURL;
							s.openaiModel = OPENAI_PRESETS[v].model;
						} else {
							s.openaiBaseURL = "";
						}
						await save();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("接口地址")
			.setDesc("OpenAI 兼容的 base URL，插件会在后面加上 /chat/completions。")
			.addText((t) =>
				t
					.setPlaceholder("https://api.example.com/v1")
					.setValue(s.openaiBaseURL)
					.onChange(async (v) => {
						s.openaiBaseURL = v.trim().replace(/\/+$/, "");
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("模型 ID")
			.addText((t) =>
				t
					.setPlaceholder("deepseek-flash")
					.setValue(s.openaiModel)
					.onChange(async (v) => {
						s.openaiModel = v.trim();
						await save();
					}),
			);
	}

	private displayAnthropic(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		const showCustom = this.editingCustomModel || !(s.model in MODEL_OPTIONS);
		new Setting(containerEl)
			.setName("模型")
			.addDropdown((d) =>
				d
					.addOptions(MODEL_OPTIONS)
					.setValue(showCustom ? "custom" : s.model)
					.onChange(async (v) => {
						this.editingCustomModel = v === "custom";
						if (v !== "custom") s.model = v;
						await save();
						this.display();
					}),
			);
		if (showCustom) {
			new Setting(containerEl)
				.setName("自定义模型 ID")
				.addText((t) =>
					t
						.setPlaceholder("claude-opus-5")
						.setValue(s.model in MODEL_OPTIONS ? "" : s.model)
						.onChange(async (v) => {
							s.model = v.trim() || DEFAULT_SETTINGS.model;
							await save();
						}),
				);
		}

		new Setting(containerEl)
			.setName("思考强度 (effort)")
			.setDesc("越高查验越仔细，但更慢、更贵。Haiku 不支持此项。")
			.addDropdown((d) =>
				d
					.addOptions({ low: "low", medium: "medium", high: "high（默认）", xhigh: "xhigh", max: "max" })
					.setValue(s.effort)
					.onChange(async (v) => {
						s.effort = v as Effort;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("拒答时自动换用备用模型")
			.setDesc("Opus 5 的安全分类器偶尔会误拒正常内容，开启后由服务端自动改用推荐的备用模型重试。使用自定义代理地址时若报错可关闭。")
			.addToggle((t) =>
				t.setValue(s.useFallbacks).onChange(async (v) => {
					s.useFallbacks = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("自定义 API 地址")
			.setDesc("留空使用官方地址 https://api.anthropic.com。")
			.addText((t) =>
				t
					.setPlaceholder("https://api.anthropic.com")
					.setValue(s.baseURL)
					.onChange(async (v) => {
						s.baseURL = v.trim();
						await save();
					}),
			);
	}
}

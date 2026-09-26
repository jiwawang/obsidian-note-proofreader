# Note Proofreader

Obsidian 插件：选中一段笔记，让大模型检查其中的**事实性错误**，以你的原话为准、只改确实错的地方，然后把改动以颗粒动画写回原处。

*Select a passage in a note; the plugin asks an LLM (DeepSeek, Gemini, OpenRouter, Claude, or any OpenAI-compatible endpoint) to fix only factual errors, keeping your own wording, and writes the corrections back in place with a particle dissolve-and-reform animation. Changed spots are marked with `==highlight==`. One `Ctrl+Z` undoes the whole edit.*

## 使用

- **右键 → 审阅修改**：弹出一个「额外要求」输入框（可留空，会记住上次内容），回车即开始。留空只修正事实性错误；填了则额外按你的要求改。
- **双击 Alt**（Mac 上是 Option ⌥）：直接修正选区内的事实性错误，不弹任何窗口。
- 两种方式都不需要确认。不满意 `Ctrl/Cmd+Z` 一步还原整次修改。
- 没有选中文字时什么都不做。

等待期间选区上有浅蓝流光。结果回来后：
- 整段选中文字碎成墨色细粒、从左到右依次散开，再由细粒聚成修正后的文字。
- 改动处以 `==高亮==` 写入笔记作为长期标记；插件默认把笔记里的高亮显示为浅蓝（设置里可关）。
- 没发现问题时，整段绿色闪两下。
- 动画中按 `Esc` 直接跳到结果。

命令面板里还有：「审阅修改（仅事实错误）」「审阅修改（填写额外要求）」「取消正在进行的审阅」，以及「演示动画（不调用 API）」——在光标处插入一段示例并播放修正，`Ctrl+Z` 一次清掉。

## 安装

**从社区插件市场**（上架后）：设置 → 第三方插件 → 浏览 → 搜索 “Note Proofreader”。

**上架前，用 BRAT 安装并自动更新**：
1. 安装社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. BRAT 设置 → Add Beta plugin → 填 `jiwawang/obsidian-note-proofreader`。
3. 之后每次本仓库发布新版本，BRAT 会在 Obsidian 里自动更新。

**手动**：从 [Releases](https://github.com/jiwawang/obsidian-note-proofreader/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放到 `<仓库>/.obsidian/plugins/note-proofreader/`，重启后在「第三方插件」里启用。

**从源码构建**：`npm install && npm run build`，产物在项目根目录；`npm run dev` 监听文件自动构建。

启用后在插件设置里选服务商、填 API Key（需要 Obsidian 1.11.4 及以上；Key 存在 Obsidian 密钥库里，不进仓库文件）。

## 模型服务

默认走 **OpenAI 兼容接口**，预置了几家便宜的：

| 预设 | 默认模型 | 大致价格（每百万 token，输入/输出） | 备注 |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | $0.15–0.30 / $0.60–1.20 | 默认。中英文都好，一次查验约几厘钱。 |
| Google Gemini | `gemini-2.5-flash-lite` | $0.10 / $0.40，Flash 系列有免费额度 | 免费档数据可能被用于训练。 |
| OpenRouter | `openrouter/free` | 免费（随机免费模型） | 质量不稳定；可填任意模型 ID。 |
| 自定义 | — | — | 任何 OpenAI 兼容接口。 |

也可以切到 **Anthropic Claude**（默认 Claude Opus 5，更贵但查验更稳）。

## 设置

| 项目 | 说明 |
|---|---|
| 服务商 / API Key | OpenAI 兼容接口或 Anthropic Claude。 |
| 预设 / 接口地址 / 模型 ID | OpenAI 兼容接口的设置。 |
| 思考强度 / 备用模型 / 自定义地址 | 仅 Claude。 |
| 参考上下文长度 | 随选区发送、供理解前后文的笔记字符数。 |
| 双击 Alt / Option / 间隔 | 可关闭，可调判定间隔。 |
| 高亮显示为浅蓝 | 影响笔记里所有 `==高亮==`。 |
| 颗粒动画 | 总开关。动画参数在 `src/params.ts` 里固定。 |

## 网络与隐私 / Network use

- 每次审阅，插件会把**选中的段落和它周围的笔记内容**（默认约 2 万字符，可在设置里调小）发送到你选择的模型服务商（DeepSeek、Google、OpenRouter、Anthropic 或你填写的自定义地址）。除此之外不发送任何数据，也不做统计上报。
- API Key 由你自己提供，费用计入你自己的账户；Key 保存在 Obsidian 的密钥库中，不写入仓库文件。
- 查验依靠模型自身的知识，不联网搜索；拿不准的内容不会改。

*Each review sends the selected passage plus surrounding note text (about 20k characters by default, adjustable) to the LLM provider you configured. Nothing else is sent; there is no telemetry. You supply your own API key, stored in Obsidian's secret storage.*

## 许可

MIT

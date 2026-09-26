# Veritas Howler – Note Proofreader

Select a passage in a note and let an LLM check it for **factual errors**. Your own wording is kept; only what is actually wrong gets fixed. The corrected passage dissolves into ink particles and re-forms in place, changed spots are marked with a light-blue `==highlight==`, and a short teacher-style note appears right under the passage: what you got right, or what was wrong and why.

*中文说明见下方。*

## Usage

- **Right-click → Veritas Howler → 审阅修改 (Review)**: asks for optional extra instructions (remembered for next time), then reviews. Leave it empty to fix factual errors only.
- **Double-tap Alt** (**Option ⌥** on Mac): reviews the selection immediately, facts only, no dialog.
- **Right-click → Veritas Howler → 取消高亮 (Remove highlights)**: strips the `==` markers in the selection and keeps the text.
- Nothing asks for confirmation. `Ctrl/Cmd+Z` undoes a whole review in one step. With no selection, nothing happens.

While waiting, the selection shimmers in light blue. When the result arrives:

- The passage dissolves into particles and re-forms with the corrections; press `Esc` to skip the animation.
- If nothing needed changing, the passage flashes green twice.
- A frosted-glass card under the passage gives the verdict: the key point you got right, or what was wrong, why, and the correct idea, plus at most one pointed remark. Close it with the round × in its corner.

The command palette also has *审阅修改（仅事实错误）*, *审阅修改（填写额外要求）*, *取消高亮（选区）*, *取消正在进行的审阅*, and *演示动画（不调用 API）* (inserts a sample passage and plays the correction without calling any API; one `Ctrl+Z` removes it).

## Installation

- **Community plugins** (once listed): Settings → Community plugins → Browse → search "Veritas Howler".
- **BRAT** (for pre-releases): install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* → `jiwawang/obsidian-note-proofreader`. BRAT keeps it updated.
- **Manual**: download `main.js`, `manifest.json` and `styles.css` from [Releases](https://github.com/jiwawang/obsidian-note-proofreader/releases) into `<vault>/.obsidian/plugins/note-proofreader/`, then enable the plugin.

Requires Obsidian 1.13.0 or later. After enabling, pick a provider and add your API key in the plugin settings.

## LLM providers

The default is any **OpenAI-compatible endpoint**, with presets for inexpensive options:

| Preset | Default model | Rough price (per 1M tokens, in / out) | Notes |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | $0.15–0.30 / $0.60–1.20 | Default. Good in Chinese and English; a review costs a fraction of a cent. |
| Google Gemini | `gemini-2.5-flash-lite` | $0.10 / $0.40; Flash models have a free tier | On the free tier your text may be used for training. |
| OpenRouter | `openrouter/free` | free (random free models) | Quality varies; any model ID works. |
| Custom | — | — | Any OpenAI-compatible endpoint. |

You can also switch to **Anthropic Claude** (default Claude Opus 5; more expensive, more reliable checking).

## Settings

| Setting | What it does |
|---|---|
| Provider / API key | OpenAI-compatible endpoint or Anthropic Claude. |
| Preset / base URL / model ID | For OpenAI-compatible endpoints. |
| Effort / fallback model / custom URL | Claude only. |
| Context length | How many characters of the surrounding note are sent for context. |
| Double-tap Alt / interval | Turn the shortcut off, or tune how fast the two taps must be. |
| Feedback card duration | How long the card stays; 0 keeps it until you close it. |
| Light-blue highlights | Shows every `==highlight==` in your vault in light blue. |
| Particle animation | Master switch. Animation timings are fixed in `src/params.ts`. |

## Network use and privacy

- Each review sends **the selected passage and the surrounding note text** (about 20,000 characters by default, adjustable) to the provider you configured: DeepSeek, Google, OpenRouter, Anthropic, or your custom URL. Nothing else is sent, and there is no telemetry.
- You supply your own API key and pay your provider directly. The key is kept in Obsidian's secret storage, not in your vault files.
- Checking relies on the model's own knowledge; it does not search the web. When the model is unsure, it leaves the text alone.

## Build from source

```bash
npm install
npm run build
```

`npm run dev` rebuilds on change.

## License

MIT

---

## 中文说明

选中一段笔记，让大模型检查其中的**事实性错误**。以你的原话为准，只改确实错的地方。修正后的段落会化成墨色颗粒、再在原处重新聚成；改动处写入浅蓝色 `==高亮==`；段落正下方出现一张毛玻璃卡片，像老师一样告诉你：哪里对、对在哪，或者哪里错、为什么错。

- **右键 → Veritas Howler → 审阅修改**：可填写额外要求（会记住上次内容），留空则只修正事实错误。
- **双击 Alt**（Mac 上是 **Option ⌥**）：直接只修正事实错误，不弹窗。
- **右键 → Veritas Howler → 取消高亮**：去掉选区里的 `==` 标记，保留文字。
- 都不需要确认；不满意 `Ctrl/Cmd+Z` 一步还原。没有选中文字时什么都不做。
- 默认使用 DeepSeek（OpenAI 兼容接口），也可切换 Gemini、OpenRouter、自定义接口或 Anthropic Claude。
- 每次审阅会把选中段落及周围笔记内容发送给你选择的服务商，除此之外不发送任何数据；API key 存在 Obsidian 密钥库中，不写入仓库文件。
- 需要 Obsidian 1.13.0 及以上。

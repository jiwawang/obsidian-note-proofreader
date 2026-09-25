import { App, Modal, Setting } from "obsidian";

/** Asks for this run's extra instructions; resolves with the text, or null if dismissed. */
export class ExtraRequirementsModal extends Modal {
	private value: string;
	private submitted = false;
	private resolve!: (v: string | null) => void;

	constructor(app: App, lastValue: string) {
		super(app);
		this.value = lastValue;
	}

	ask(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("np-extra-modal");
		this.setTitle("审阅修改");
		contentEl.createEl("p", { text: "额外要求（可留空，留空则只修正事实性错误）", cls: "np-extra-hint" });

		const input = contentEl.createEl("textarea", { cls: "np-extra-input" });
		input.rows = 3;
		input.placeholder = "例如：术语统一用英文；把年份改成公元纪年";
		input.value = this.value;
		input.addEventListener("input", () => (this.value = input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("开始").setCta().onClick(() => this.submit()));

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	private submit() {
		this.submitted = true;
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		this.resolve(this.submitted ? this.value : null);
	}
}

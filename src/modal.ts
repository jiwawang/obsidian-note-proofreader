import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";

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
		this.setTitle(t().modalTitle);
		contentEl.createEl("p", { text: t().modalHint, cls: "np-extra-hint" });

		const input = contentEl.createEl("textarea", { cls: "np-extra-input" });
		input.rows = 3;
		input.placeholder = t().modalPlaceholder;
		input.value = this.value;
		input.addEventListener("input", () => (this.value = input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t().cancel).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t().start).setCta().onClick(() => this.submit()));

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

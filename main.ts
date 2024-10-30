import { App, Plugin, PluginSettingTab, Setting, TFile, MarkdownView } from 'obsidian';
import { ViewPlugin, DecorationSet, Decoration, ViewUpdate, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { moment } from 'obsidian';

// Enums for better type safety and maintainability
enum DateCategory {
	Recent = 'recent',
	Intermediate = 'intermediate',
	Old = 'old'
}

interface DateHighlighterSettings {
	highlightInlineContent: boolean;
	highlightFilenames: boolean;
	colors: {
		[DateCategory.Recent]: string;
		[DateCategory.Intermediate]: string;
		[DateCategory.Old]: string;
	};
	periods: {
		recent: number;
		intermediate: number;
	};
	textColor: string;
}

const DEFAULT_SETTINGS: DateHighlighterSettings = {
	highlightInlineContent: true,
	highlightFilenames: true,
	colors: {
		[DateCategory.Recent]: '#a4e7c3',
		[DateCategory.Intermediate]: '#e7dba4',
		[DateCategory.Old]: '#e7a4a4'
	},
	periods: {
		recent: 14,
		intermediate: 30
	},
	textColor: '#000000'
};

// Date format configuration for better maintainability
const DATE_FORMATS = {
	patterns: [
		/\d{4}-\d{2}-\d{2}/g,    // YYYY-MM-DD
		/\d{2}\/\d{2}\/\d{4}/g,  // MM/DD/YYYY
		/\d{2}-\d{2}-\d{4}/g,    // DD-MM-YYYY
		/\d{4}\.\d{2}\.\d{2}/g   // YYYY.MM.DD
	],
	momentFormats: ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY', 'YYYY.MM.DD']
};

class DateService {
	static parseDate(dateStr: string): moment.Moment | null {
		for (const format of DATE_FORMATS.momentFormats) {
			const parsed = moment(dateStr, format, true);
			if (parsed.isValid()) {
				return parsed;
			}
		}
		return null;
	}

	static findDatesInText(text: string): string[] {
		return DATE_FORMATS.patterns.flatMap(regex =>
			text.match(regex) || []
		);
	}

	static generateTooltip(dateStr: string): string {
		const date = this.parseDate(dateStr);
		if (!date) return '';

		const now = moment();
		const daysDiff = now.diff(date, 'days');

		switch (daysDiff) {
			case 0: return 'Today';
			case 1: return 'Yesterday';
			case -1: return 'Tomorrow';
			default:
				const daysText = Math.abs(daysDiff);
				return daysDiff > 0
					? `${daysText} days ago`
					: `In ${daysText} days`;
		}
	}

	static getHighlightColor(
		dateStr: string,
		settings: DateHighlighterSettings
	): { bg: string; text: string } {
		const date = this.parseDate(dateStr);
		if (!date) return { bg: settings.colors[DateCategory.Old], text: settings.textColor };

		const daysSince = moment().diff(date, 'days');

		if (daysSince <= settings.periods.recent) {
			return {
				bg: settings.colors[DateCategory.Recent],
				text: settings.textColor
			};
		}

		if (daysSince <= settings.periods.intermediate) {
			return {
				bg: settings.colors[DateCategory.Intermediate],
				text: settings.textColor
			};
		}

		return {
			bg: settings.colors[DateCategory.Old],
			text: settings.textColor
		};
	}
}

export default class DateHighlighterPlugin extends Plugin {
	settings: DateHighlighterSettings;
	private styleElement: HTMLStyleElement;

	async onload() {
		await this.loadSettings();
		this.initializePlugin();
	}

	private initializePlugin() {
		this.addSettingTab(new DateHighlighterSettingTab(this.app, this));
		this.registerEditorExtension([createDateHighlighter(this)]);
		this.setupStyleElement();
		this.registerEvents();
	}

	private setupStyleElement() {
		this.styleElement = document.createElement('style');
		document.head.appendChild(this.styleElement);
		this.updateFileStyles();

		this.register(() => this.styleElement.remove());
	}

	private registerEvents() {
		this.registerEvent(
			this.app.vault.on('rename', () => this.updateFileStyles())
		);
	}

	updateFileStyles() {
		if (!this.settings.highlightFilenames) {
			this.styleElement.textContent = '';
			return;
		}

		const styleContent = this.generateFileStyles();
		this.styleElement.textContent = styleContent;
	}

	private generateFileStyles(): string {
		return this.app.vault.getFiles()
			.map(file => {
				const dates = DateService.findDatesInText(file.path);
				if (!dates.length) return '';

				const colors = DateService.getHighlightColor(dates[0], this.settings);
				const safeFileName = CSS.escape(file.path);

				return `
          .nav-file-title[data-path="${safeFileName}"] {
            background-color: ${colors.bg} !important;
            color: ${colors.text} !important;
          }
        `;
			})
			.join('');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateFileStyles();
		this.refreshActiveEditors();
	}

	private refreshActiveEditors() {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			const view = leaf.view as MarkdownView;
			// Access the editor's CM instance safely using the modern approach
			if (view?.editor && 'cm' in view.editor) {
				const cm6 = (view.editor as any).cm as EditorView;
				cm6.dispatch({});
			}
		});
	}
}

class DateHighlighterSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DateHighlighterPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.createGeneralSettings();
		this.createTimePeriodSettings();
		this.createColorSettings();
	}

	private createGeneralSettings() {
		const { containerEl } = this;
		containerEl.createEl('h2', { text: 'Date Highlighter Settings' });

		new Setting(containerEl)
			.setName('Highlight inline dates')
			.setDesc('Highlight dates within note content')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.highlightInlineContent)
				.onChange(async (value) => {
					this.plugin.settings.highlightInlineContent = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Highlight filenames')
			.setDesc('Highlight dates in file names')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.highlightFilenames)
				.onChange(async (value) => {
					this.plugin.settings.highlightFilenames = value;
					await this.plugin.saveSettings();
				}));
	}

	private createTimePeriodSettings() {
		const { containerEl } = this;
		containerEl.createEl('h3', { text: 'Time Periods' });

		new Setting(containerEl)
			.setName('Recent period (days)')
			.setDesc('Number of days to consider as recent (green)')
			.addText(text => text
				.setValue(this.plugin.settings.periods.recent.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value);
					if (!isNaN(numValue) && numValue > 0) {
						this.plugin.settings.periods.recent = numValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Intermediate period (days)')
			.setDesc('Number of days to consider as intermediate (yellow)')
			.addText(text => text
				.setValue(this.plugin.settings.periods.intermediate.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value);
					if (!isNaN(numValue) && numValue > this.plugin.settings.periods.recent) {
						this.plugin.settings.periods.intermediate = numValue;
						await this.plugin.saveSettings();
					}
				}));
	}

	private createColorSettings() {
		const { containerEl } = this;
		containerEl.createEl('h3', { text: 'Colors' });

		const colorSettings = [
			{ key: DateCategory.Recent, name: 'Recent color', desc: 'Color for recent dates' },
			{ key: DateCategory.Intermediate, name: 'Intermediate color', desc: 'Color for intermediate dates' },
			{ key: DateCategory.Old, name: 'Old color', desc: 'Color for old dates' }
		];

		colorSettings.forEach(({ key, name, desc }) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addColorPicker(color => color
					.setValue(this.plugin.settings.colors[key])
					.onChange(async (value) => {
						this.plugin.settings.colors[key] = value;
						await this.plugin.saveSettings();
					}));
		});

		new Setting(containerEl)
			.setName('Text color')
			.setDesc('Color for text on highlighted dates')
			.addColorPicker(color => color
				.setValue(this.plugin.settings.textColor)
				.onChange(async (value) => {
					this.plugin.settings.textColor = value;
					await this.plugin.saveSettings();
				}));
	}
}

const createDateHighlighter = (plugin: DateHighlighterPlugin) =>
	ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.buildDecorations(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = this.buildDecorations(update.view);
				}
			}

			buildDecorations(view: EditorView) {
				if (!plugin.settings.highlightInlineContent) {
					return Decoration.none;
				}

				const builder = new RangeSetBuilder<Decoration>();

				for (let { from, to } of view.visibleRanges) {
					const text = view.state.doc.sliceString(from, to);

					DATE_FORMATS.patterns.forEach(regex => {
						let match;
						while ((match = regex.exec(text)) !== null) {
							const dateStr = match[0];
							const start = from + match.index;
							const end = start + dateStr.length;
							const colors = DateService.getHighlightColor(dateStr, plugin.settings);
							const tooltip = DateService.generateTooltip(dateStr);

							builder.add(
								start,
								end,
								Decoration.mark({
									attributes: {
										style: `background-color: ${colors.bg}; color: ${colors.text};`,
										title: tooltip
									}
								})
							);
						}
					});
				}

				return builder.finish();
			}
		},
		{
			decorations: v => v.decorations
		}
	);

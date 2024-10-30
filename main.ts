import { App, Plugin, PluginSettingTab, Setting, TFile, TAbstractFile, MarkdownView, ColorComponent } from 'obsidian';
import { ViewPlugin, DecorationSet, Decoration, ViewUpdate, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { moment } from 'obsidian';

interface DateHighlighterSettings {
	highlightInlineContent: boolean;
	highlightFilenames: boolean;
	recentColor: string;
	intermediateColor: string;
	oldColor: string;
	recentDays: number;
	intermediateDays: number;
	textColor: string;
}

const DEFAULT_SETTINGS: DateHighlighterSettings = {
	highlightInlineContent: true,
	highlightFilenames: true,
	recentColor: '#a4e7c3',
	intermediateColor: '#e7dba4',
	oldColor: '#e7a4a4',
	recentDays: 14,
	intermediateDays: 30,
	textColor: '#000000'
}

export default class DateHighlighterPlugin extends Plugin {
	settings: DateHighlighterSettings;
	styleElement: HTMLStyleElement;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new DateHighlighterSettingTab(this.app, this));

		this.registerEditorExtension([dateHighlighter(this)]);

		this.styleElement = document.createElement('style');
		document.head.appendChild(this.styleElement);

		this.updateFileStyles();

		this.registerEvent(
			this.app.vault.on('rename', () => {
				this.updateFileStyles();
			})
		);

		this.register(() => {
			this.styleElement.remove();
		});
	}

	updateFileStyles() {
		if (!this.settings.highlightFilenames) {
			this.styleElement.textContent = '';
			return;
		}

		let styleContent = '';
		const files = this.app.vault.getFiles();

		files.forEach(file => {
			const dates = findDatesInText(file.name);
			if (dates.length > 0) {
				const dateStr = dates[0];
				const colors = getHighlightColor(dateStr, this.settings);
				const safeFileName = CSS.escape(file.path);

				styleContent += `
                    .nav-file-title[data-path="${safeFileName}"] {
                        background-color: ${colors.bg} !important;
                        color: ${colors.text} !important;
                    }
                `;
			}
		});

		this.styleElement.textContent = styleContent;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateFileStyles();
		this.refreshActiveEditors();
	}

	refreshActiveEditors() {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			const view = leaf.view as MarkdownView;
			if (view?.editor?.cm) {
				// @ts-ignore
				const cm6 = view.editor.cm;
				cm6.dispatch({});
			}
		});
	}
}

class DateHighlighterSettingTab extends PluginSettingTab {
	plugin: DateHighlighterPlugin;

	constructor(app: App, plugin: DateHighlighterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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

		containerEl.createEl('h3', { text: 'Time Periods' });

		new Setting(containerEl)
			.setName('Recent period (days)')
			.setDesc('Number of days to consider as recent (green)')
			.addText(text => text
				.setValue(this.plugin.settings.recentDays.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value);
					if (!isNaN(numValue) && numValue > 0) {
						this.plugin.settings.recentDays = numValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Intermediate period (days)')
			.setDesc('Number of days to consider as intermediate (yellow)')
			.addText(text => text
				.setValue(this.plugin.settings.intermediateDays.toString())
				.onChange(async (value) => {
					const numValue = parseInt(value);
					if (!isNaN(numValue) && numValue > this.plugin.settings.recentDays) {
						this.plugin.settings.intermediateDays = numValue;
						await this.plugin.saveSettings();
					}
				}));

		containerEl.createEl('h3', { text: 'Colors' });

		new Setting(containerEl)
			.setName('Recent color')
			.setDesc('Color for recent dates')
			.addColorPicker(color => color
				.setValue(this.plugin.settings.recentColor)
				.onChange(async (value) => {
					this.plugin.settings.recentColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Intermediate color')
			.setDesc('Color for intermediate dates')
			.addColorPicker(color => color
				.setValue(this.plugin.settings.intermediateColor)
				.onChange(async (value) => {
					this.plugin.settings.intermediateColor = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Old color')
			.setDesc('Color for old dates')
			.addColorPicker(color => color
				.setValue(this.plugin.settings.oldColor)
				.onChange(async (value) => {
					this.plugin.settings.oldColor = value;
					await this.plugin.saveSettings();
				}));

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

// Combined regex for multiple date formats
const DATE_FORMATS = [
	/\d{4}-\d{2}-\d{2}/g,  // YYYY-MM-DD
	/\d{2}\/\d{2}\/\d{4}/g, // MM/DD/YYYY
	/\d{2}-\d{2}-\d{4}/g,  // DD-MM-YYYY
	/\d{4}\.\d{2}\.\d{2}/g  // YYYY.MM.DD
];

function parseDate(dateStr: string): moment.Moment | null {
	const formats = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY', 'YYYY.MM.DD'];
	for (const format of formats) {
		const parsed = moment(dateStr, format, true);
		if (parsed.isValid()) {
			return parsed;
		}
	}
	return null;
}

function findDatesInText(text: string): string[] {
	const dates: string[] = [];
	for (const regex of DATE_FORMATS) {
		const matches = text.match(regex);
		if (matches) {
			dates.push(...matches);
		}
	}
	return dates;
}

function generateDateTooltip(dateStr: string): string {
	const date = parseDate(dateStr);
	if (!date) return '';

	const now = moment();
	const daysDiff = now.diff(date, 'days');
	const daysText = Math.abs(daysDiff);

	if (daysDiff === 0) return 'Today';
	if (daysDiff === 1) return 'Yesterday';
	if (daysDiff === -1) return 'Tomorrow';

	return daysDiff > 0
		? `${daysText} days ago`
		: `In ${daysText} days`;
}

function getHighlightColor(dateStr: string, settings: DateHighlighterSettings): { bg: string, text: string } {
	const date = parseDate(dateStr);
	if (!date) return { bg: settings.oldColor, text: settings.textColor };

	const today = moment();
	const daysSince = today.diff(date, 'days');

	if (daysSince <= settings.recentDays) {
		return {
			bg: settings.recentColor,
			text: settings.textColor
		};
	} else if (daysSince <= settings.intermediateDays) {
		return {
			bg: settings.intermediateColor,
			text: settings.textColor
		};
	} else {
		return {
			bg: settings.oldColor,
			text: settings.textColor
		};
	}
}

const dateHighlighter = (plugin: DateHighlighterPlugin) => ViewPlugin.fromClass(class {
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

			for (const regex of DATE_FORMATS) {
				let match;
				while ((match = regex.exec(text)) !== null) {
					const dateStr = match[0];
					const start = from + match.index;
					const end = start + dateStr.length;
					const colors = getHighlightColor(dateStr, plugin.settings);
					const tooltip = generateDateTooltip(dateStr);

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
			}
		}

		return builder.finish();
	}
}, {
	decorations: v => v.decorations
});


// Define suggestion item interface
import {Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Plugin} from "obsidian";

export interface StatPluginSuggestion {
	text: string;
	description: string;
}

// Create a custom EditorSuggest class
export class StatPluginSuggest extends EditorSuggest<StatPluginSuggestion> {
	plugin: Plugin;

	constructor(plugin: Plugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line);
		const subString = line.substring(0, cursor.ch);

		// Check if we have "sp." as trigger
		const match = subString.match(/sp\.([a-zA-Z]*)$/);
		if (!match) return null;

		// Check if we're inside a statblock code block
		let inStatBlock = false;
		let lineNum = cursor.line;
		while (lineNum >= 0) {
			const text = editor.getLine(lineNum);
			if (text.match(/^```statblock\s*$/)) {
				inStatBlock = true;
				break;
			}
			if (text.match(/^```/)) {
				break;
			}
			lineNum--;
		}

		if (!inStatBlock) return null;

		return {
			start: {
				line: cursor.line,
				ch: match.index! + 3 // Start after "sp."
			},
			end: cursor,
			query: match[1] || ""
		};
	}

	getSuggestions(context: EditorSuggestContext): StatPluginSuggestion[] {
		const suggestions: StatPluginSuggestion[] = [
			{
				text: 'pages()',
				description: 'Get all pages or pages in a specific folder'
			},
			{
				text: 'page(path)',
				description: 'Get a specific page by path'
			},
			{
				text: 'header(level, text)',
				description: 'Create a header element'
			},
			{
				text: 'span(text)',
				description: 'Create a span element'
			},
			{
				text: 'list(items)',
				description: 'Create a list from an array of items'
			},
			{
				text: 'table(headers, rows)',
				description: 'Create a table with headers and data rows'
			},
			{
				text: 'chart(label, values, labels)',
				description: 'Create a chart with the given data'
			},
			{
				text: 'folder(folderPath)',
				description: 'List files and folders in the specified folder'
			},
			{
				text: 'app',
				description: 'Access the Obsidian API'
			}
		];

		// Filter suggestions based on partial input
		const query = context.query.toLowerCase();
		return suggestions.filter(s => s.text.toLowerCase().includes(query));
	}

	renderSuggestion(suggestion: StatPluginSuggestion, el: HTMLElement): void {
		el.createEl('div', { text: suggestion.text });
		el.createEl('small', { text: suggestion.description });
	}

	selectSuggestion(suggestion: StatPluginSuggestion): void {
		const { editor } = this.context!;
		editor.replaceRange(
			suggestion.text,
			this.context!.start,
			this.context!.end
		);
	}
}

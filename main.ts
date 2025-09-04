import {
	Plugin,
	TFile,
	TFolder
} from 'obsidian';

import {Chart, BarController, BarElement, CategoryScale, LinearScale} from 'chart.js';
import {StateField} from '@codemirror/state';
import {EditorView, Decoration} from '@codemirror/view';
import {javascript} from '@codemirror/lang-javascript';
import {StatPluginSuggest} from "./editor-suggest";

export default class StatPlugin extends Plugin {
	// Store all open code blocks for refreshing
	private codeBlockInstances: Map<string, {
		source: string,
		element: HTMLElement,
		context: any
	}> = new Map();

	// Debounce timeout ID
	private debounceTimer: NodeJS.Timeout | null = null;
	private debounceInterval = 1000; // ms

	async onload() {
		Chart.register(BarController, BarElement, CategoryScale, LinearScale);

		// Register CodeMirror extensions for syntax highlighting
		this.registerEditorExtension(this.createCodeBlockExtension());

		this.registerEditorSuggest(new StatPluginSuggest(this));

		// Register file change events with debouncing
		this.registerFileWatcher();

		this.registerMarkdownCodeBlockProcessor('statblock', (source, el, ctx) => {
			try {
				// Store this instance for refreshing later
				const instanceId = ctx.sourcePath + ":" + Math.random().toString(36).substring(2, 9);
				this.codeBlockInstances.set(instanceId, {source, element: el, context: ctx});

				// Clean up on element detach using MutationObserver
				if (el.parentNode) {
					const observer = new MutationObserver((mutations, obs) => {
						for (const mutation of mutations) {
							if (mutation.type === 'childList' &&
								mutation.removedNodes.length) {

								const removed = Array.from(mutation.removedNodes);
								if (removed.some(node => node === el || node.contains(el))) {
									this.codeBlockInstances.delete(instanceId);
									obs.disconnect();
									break;
								}
							}
						}
					});

					observer.observe(el.parentNode, {childList: true, subtree: true});
					this.register(() => observer.disconnect());
				}

				// Create a div to hold the output (allows for easy clearing)
				const outputContainer = el.createDiv({cls: 'statblock-output-container'});

				this.runCodeBlock(source, outputContainer, instanceId);
			} catch (e) {
				const errorEl = el.createEl('div');
				errorEl.setText(`Error executing code: ${e.message}`);
				errorEl.style.color = 'red';
			}
		});

		// Add custom CSS for styling code blocks
		const styleEl = document.createElement('style');
		styleEl.textContent = `
            .sp-block-highlighted {
                background-color: rgba(54, 162, 235, 0.1);
                border-left: 2px solid rgba(54, 162, 235, 0.7);
            }
            
            .cm-line .sp-block-keyword {
                color: #d73a49;
                font-weight: bold;
            }
            
            .cm-line .sp-block-property {
                color: #6f42c1;
            }
            
            .cm-line .sp-block-function {
                color: #005cc5;
            }
            
            .statblock-output-container {
                padding-top: 8px;
            }
            
            /* Add refresh indicator */
            .statblock-refreshing {
                position: absolute;
                top: 0;
                right: 0;
                padding: 4px 8px;
                background-color: rgba(0, 0, 0, 0.1);
                border-radius: 4px;
                font-size: 12px;
                opacity: 0.7;
            }
        `;
		document.head.appendChild(styleEl);
		// When plugin is disabled, we'll remove this style
		this.register(() => styleEl.remove());
	}

	// Create a CodeMirror extension for syntax highlighting
	private createCodeBlockExtension() {
		// Use StateField to manage decorations
		const myCustomBlockHighlighter = StateField.define({
			create() {
				return Decoration.none;
			},
			update(oldState, transaction) {
				// We need to use an array of decorations
				const decorations = [];

				// Find all code blocks with statblock language
				const doc = transaction.state.doc;
				let inCodeBlock = false;
				let codeBlockStart = 0;

				for (let i = 1; i <= doc.lines; i++) {
					const line = doc.line(i);
					const text = line.text;

					if (text.match(/^```statblock\s*$/)) {
						inCodeBlock = true;
						codeBlockStart = line.from;
					} else if (inCodeBlock && text.match(/^```\s*$/)) {
						// Add decoration for the whole code block - we'll skip this for now
						// as it was causing issues
						inCodeBlock = false;
					} else if (inCodeBlock) {
						// Highlight keywords
						const keywordMatches = Array.from(text.matchAll(/\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|new)\b/g));
						for (const match of keywordMatches) {
							if (match.index !== undefined) {
								decorations.push(Decoration.mark({
									class: 'sp-block-keyword'
								}).range(
									line.from + match.index,
									line.from + match.index + match[0].length
								));
							}
						}

						// Highlight sp properties
						const propMatches = Array.from(text.matchAll(/sp\.(pages|page|header|span|list|table|chart|folder|refresh)\b/g));
						for (const match of propMatches) {
							if (match.index !== undefined) {
								const dotIndex = match[0].indexOf('.');
								decorations.push(Decoration.mark({
									class: 'sp-block-function'
								}).range(
									line.from + match.index + dotIndex + 1,
									line.from + match.index + match[0].length
								));
							}
						}
					}
				}

				// Create a new decoration set correctly
				return Decoration.set(decorations);
			},
			provide(field) {
				return EditorView.decorations.from(field);
			}
		});

		// Combine with JavaScript language support
		return [myCustomBlockHighlighter, javascript()];
	}

	// Register file change events with debouncing
	private registerFileWatcher() {
		// Debounced handler for file changes
		const debouncedRefresh = (file?: TFile) => {
			// Clear any existing timeout
			if (this.debounceTimer) {
				clearTimeout(this.debounceTimer);
			}

			// Set a new timeout
			this.debounceTimer = setTimeout(() => {
				this.refreshAllCodeBlocks();
				this.debounceTimer = null;
			}, this.debounceInterval);
		};

		// Monitor file changes in the vault
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				debouncedRefresh(file instanceof TFile ? file : undefined);
			})
		);

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				debouncedRefresh(file instanceof TFile ? file : undefined);
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				debouncedRefresh(file instanceof TFile ? file : undefined);
			})
		);

		// Also refresh when the active leaf changes (like switching tabs)
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				debouncedRefresh();
			})
		);

		// Refresh when layout changes (like split views)
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				debouncedRefresh();
			})
		);

		// Refresh when metadata cache is resolved
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				debouncedRefresh();
			})
		);
	}

	// Refresh all code blocks
	private refreshAllCodeBlocks() {
		for (const [instanceId, instance] of this.codeBlockInstances) {
			this.refreshCodeBlock(instanceId);
		}
	}

	private runCodeBlock(source: string, outputContainer: HTMLElement, instanceId: string) {
		try {
			const sandbox = {
				sp: {
					page: (path: string) => {
						const file = this.app.vault.getAbstractFileByPath(path);
						if (file instanceof TFile) {
							const cache = this.app.metadataCache.getFileCache(file);
							return {
								...cache?.frontmatter,
								file: {
									path: file.path,
									name: file.name,
									basename: file.basename,
									extension: file.extension,
									mtime: file.stat.mtime,
									ctime: file.stat.ctime,
									size: file.stat.size,
								}
							};
						}
						return null;
					},

					pages: (folder = "") => {
						return this.app.vault.getMarkdownFiles()
							.filter(file => folder ? file.path.startsWith(folder) : true)
							.map(file => {
								const cache = this.app.metadataCache.getFileCache(file);
								return {
									...cache?.frontmatter,
									file: {
										path: file.path,
										name: file.name,
										basename: file.basename,
										extension: file.extension,
										mtime: file.stat.mtime,
										ctime: file.stat.ctime,
										size: file.stat.size,
									}
								};
							});
					},
					folder: (folderPath: string) => {
						// Get the folder from the vault
						const folder = this.app.vault.getAbstractFileByPath(folderPath);

						if (!folder || !(folder instanceof TFolder)) {
							return {
								files: [],
								folders: [],
								error: `Folder "${folderPath}" not found or is not a folder`
							};
						}

						// Get all children of the folder
						const children = folder.children;
						const app = this.app;
						// Separate into files and subfolders
						return children.filter(child => child instanceof TFile).map(file => {
							const f = file as TFile;
							return {
								name: f.name,
								basename: f.basename,
								extension: f.extension,
								path: f.path,
								mtime: f.stat.mtime,
								ctime: f.stat.ctime,
								size: f.stat.size,
								isMarkdown: f.extension === 'md',
								get properties() {
									return app.metadataCache.getFileCache(f)?.frontmatter
								}
							};
						});
					},

					header: (level: number, text: string) => {
						// @ts-ignore
						return outputContainer.createEl(`h${level}`, {text});
					},

					paragraph: (text: string) => {
						return outputContainer.createEl('p', {text});
					},

					span: (text: string) => {
						return outputContainer.createEl('span', {text});
					},

					list: (items: any[]) => {
						const ul = outputContainer.createEl('ul');
						for (const item of items) {
							if (typeof item === 'string') {
								ul.createEl('li', {text: item});
							} else {
								const li = ul.createEl('li');
								li.append(item);
							}
						}
						return ul;
					},

					table: (headers: string[], rows: any[][]) => {
						const table = outputContainer.createEl('table');

						// Create header row
						const thead = table.createEl('thead');
						const headerRow = thead.createEl('tr');
						for (const header of headers) {
							headerRow.createEl('th', {text: header});
						}

						// Create data rows
						const tbody = table.createEl('tbody');
						for (const row of rows) {
							const tr = tbody.createEl('tr');
							for (const cell of row) {
								if (typeof cell === 'string' || typeof cell === 'number') {
									tr.createEl('td', {text: String(cell)});
								} else {
									const td = tr.createEl('td');
									td.append(cell);
								}
							}
						}

						return table;
					},

					// Chart.js integration
					chart: (label: string, values: number[], labels: string[]) => {
						const canvas = outputContainer.createEl('canvas');
						const ctx = canvas.getContext('2d');
						if (ctx) {
							new Chart(ctx, {
								type: 'bar',
								data: {
									labels: labels,
									datasets: [{
										label: label,
										data: values,
										backgroundColor: 'rgba(54, 162, 235, 0.2)',
									}]
								}
							});
						}
						return canvas;
					},

					// Expose the app object for full API access if needed
					app: this.app,

					// Expose container element
					container: outputContainer,

					// Add refresh function
					refresh: () => {
						this.refreshCodeBlock(instanceId);
					}
				}
			};

			// Execute the code
			const fn = new Function(...Object.keys(sandbox), source);
			fn(...Object.values(sandbox));

		} catch (e) {
			const errorEl = outputContainer.createEl('div');
			errorEl.setText(`Error executing code: ${e.message}`);
			errorEl.style.color = 'red';
		}
	}

	// Refresh a specific code block
	private refreshCodeBlock(instanceId: string) {
		const instance = this.codeBlockInstances.get(instanceId);
		if (!instance) return;

		const {source, element, context} = instance;

		// Create a refresh indicator
		const refreshIndicator = element.createDiv({
			cls: 'statblock-refreshing',
			text: 'Refreshing...'
		});

		// Clear the current content
		element.querySelectorAll('.statblock-output-container').forEach(container => {
			// Use a safer approach for removing elements
			if (container.parentNode) {
				container.parentNode.removeChild(container);
			}
		});

		// Create a new output container
		const outputContainer = element.createDiv({cls: 'statblock-output-container'});

		this.runCodeBlock(source, outputContainer, instanceId)

		// Remove the refresh indicator after a short delay
		setTimeout(() => {
			if (refreshIndicator.parentNode) {
				refreshIndicator.parentNode.removeChild(refreshIndicator);
			}
		}, 500);
	}

	onunload() {
		// Clear all code block instances
		this.codeBlockInstances.clear();

		// Clear any pending debounce timer
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}

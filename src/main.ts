import { Plugin, PluginSettingTab, Setting, App, MarkdownView, Editor, TFile } from "obsidian";

type CheckedAction = "hide" | "delete";

interface CheckerSettings {
  action: CheckedAction;
}

const DEFAULT_SETTINGS: CheckerSettings = {
  action: "delete",
};

const DELAY_MS = 2000;
const TASK_CHECKED = /^\s*- \[x\]/i;

export default class CheckerPlugin extends Plugin {
  settings: CheckerSettings;
  // Track known checked lines per file so we can detect NEW checks
  private knownChecked: Map<string, Set<string>> = new Map();
  // Track lines pending removal to avoid double-processing
  private pendingRemoval: Set<string> = new Set();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CheckerSettingTab(this.app, this));

    // Snapshot existing checked items when a file opens
    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file && file.extension === "md") {
          await this.snapshotFile(file);
        }
      })
    );

    // Snapshot the currently open file on load
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      await this.snapshotFile(activeFile);
    }

    // Detect changes: when a file is modified, compare against snapshot
    this.registerEvent(
      this.app.vault.on("modify", async (file: TFile) => {
        if (file.extension !== "md") return;

        const content = await this.app.vault.read(file);
        const lines = content.split("\n");
        const oldChecked = this.knownChecked.get(file.path) || new Set();
        const newChecked = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
          if (TASK_CHECKED.test(lines[i])) {
            newChecked.add(lines[i]);
          }
        }

        // Find lines that are checked now but weren't before
        for (const line of newChecked) {
          if (!oldChecked.has(line) && !this.pendingRemoval.has(`${file.path}:${line}`)) {
            const key = `${file.path}:${line}`;
            this.pendingRemoval.add(key);

            setTimeout(() => {
              this.pendingRemoval.delete(key);
              this.removeCheckedLine(file, line);
            }, DELAY_MS);
          }
        }

        // Update snapshot
        this.knownChecked.set(file.path, newChecked);
      })
    );
  }

  private async snapshotFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const checked = new Set<string>();
    for (const line of lines) {
      if (TASK_CHECKED.test(line)) {
        checked.add(line);
      }
    }
    this.knownChecked.set(file.path, checked);
  }

  private async removeCheckedLine(file: TFile, targetLine: string) {
    // Try editor-based removal first (for live preview)
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file === file) {
      const editor = view.editor;
      for (let i = 0; i < editor.lineCount(); i++) {
        if (editor.getLine(i) === targetLine) {
          this.processLine(editor, i);
          return;
        }
      }
    }

    // Fallback: modify via vault API (works in any mode)
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const idx = lines.indexOf(targetLine);
    if (idx === -1) return;

    if (this.settings.action === "delete") {
      lines.splice(idx, 1);
    } else {
      const match = targetLine.match(/^(\s*)- \[x\]\s+(.*)/i);
      const text = match ? match[2].trim() : targetLine.trim();
      const indent = match ? match[1] : "";
      lines[idx] = `${indent}%% - [x] ${text} %%`;
    }

    await this.app.vault.modify(file, lines.join("\n"));
  }

  private processLine(editor: Editor, lineNumber: number) {
    const line = editor.getLine(lineNumber);
    if (!TASK_CHECKED.test(line)) return;

    if (this.settings.action === "delete") {
      this.deleteLine(editor, lineNumber, line);
    } else {
      const match = line.match(/^(\s*)- \[x\]\s+(.*)/i);
      const text = match ? match[2].trim() : line.trim();
      const indent = match ? match[1] : "";
      editor.setLine(lineNumber, `${indent}%% - [x] ${text} %%`);
    }
  }

  private deleteLine(editor: Editor, lineNumber: number, line: string) {
    const lineCount = editor.lineCount();
    if (lineNumber < lineCount - 1) {
      editor.replaceRange("", { line: lineNumber, ch: 0 }, { line: lineNumber + 1, ch: 0 });
    } else if (lineNumber > 0) {
      const prevLen = editor.getLine(lineNumber - 1).length;
      editor.replaceRange("", { line: lineNumber - 1, ch: prevLen }, { line: lineNumber, ch: line.length });
    } else {
      editor.setLine(lineNumber, "");
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class CheckerSettingTab extends PluginSettingTab {
  plugin: CheckerPlugin;

  constructor(app: App, plugin: CheckerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Checked item behavior")
      .setDesc("What to do when a todo item is checked off")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hide", "Hide (wrap in comment, stays in file)")
          .addOption("delete", "Delete (permanently removed)")
          .setValue(this.plugin.settings.action)
          .onChange(async (value: string) => {
            this.plugin.settings.action = value as CheckedAction;
            await this.plugin.saveSettings();
          })
      );
  }
}

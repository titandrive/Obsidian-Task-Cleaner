import { Plugin, PluginSettingTab, Setting, App, MarkdownView, Editor, TFile, setIcon } from "obsidian";

type CheckedAction = "hide" | "delete";

interface HiddenItem {
  line: string;
  prevLine: string | null; // line immediately before this item when hidden
  seq: number;             // insertion order, used for restore ordering
}

interface CheckerSettings {
  action: CheckedAction;
  hiddenItems: Record<string, HiddenItem[]>;
}

const DEFAULT_SETTINGS: CheckerSettings = {
  action: "hide",
  hiddenItems: {},
};

const DELAY_MS = 1000;
const TASK_CHECKED = /^\s*- \[x\]/i;

export default class CheckerPlugin extends Plugin {
  settings: CheckerSettings;
  private knownChecked: Map<string, Set<string>> = new Map();
  private pendingRemoval: Set<string> = new Set();
  private showingHidden = false;
  private ribbonEl: HTMLElement;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CheckerSettingTab(this.app, this));

    this.ribbonEl = this.addRibbonIcon("eye-off", "Show hidden items", () => this.toggleShowHidden());

    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file && file.extension === "md") {
          await this.snapshotFile(file);
        }
      })
    );

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) await this.snapshotFile(activeFile);

    this.registerEvent(
      this.app.vault.on("modify", async (file: TFile) => {
        if (file.extension !== "md") return;

        const content = await this.app.vault.read(file);
        const lines = content.split("\n");
        const oldChecked = this.knownChecked.get(file.path) || new Set();
        const newChecked = new Set<string>();

        for (const line of lines) {
          if (TASK_CHECKED.test(line)) newChecked.add(line);
        }

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

        this.knownChecked.set(file.path, newChecked);
      })
    );
  }

  private async toggleShowHidden() {
    if (this.settings.action !== "hide") return;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;

    this.showingHidden = !this.showingHidden;
    setIcon(this.ribbonEl, this.showingHidden ? "eye" : "eye-off");
    this.ribbonEl.setAttribute("aria-label", this.showingHidden ? "Hide items" : "Show hidden items");

    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    if (this.showingHidden) {
      const hidden = this.settings.hiddenItems[file.path] || [];
      if (hidden.length === 0) {
        this.showingHidden = false;
        setIcon(this.ribbonEl, "eye-off");
        return;
      }

      // Restore in reverse-hide order (latest hidden first) so sequential items
      // stack correctly: each item's prevLine will already be in the array.
      const sorted = [...hidden].sort((a, b) => b.seq - a.seq);
      for (const item of sorted) {
        if (item.prevLine === null) {
          lines.splice(0, 0, item.line);
        } else {
          const prevIdx = lines.indexOf(item.prevLine);
          if (prevIdx !== -1) {
            lines.splice(prevIdx + 1, 0, item.line);
          } else {
            lines.push(item.line);
          }
        }
      }

      const newChecked = new Set<string>();
      for (const line of lines) {
        if (TASK_CHECKED.test(line)) newChecked.add(line);
      }
      this.knownChecked.set(file.path, newChecked);
      await this.app.vault.modify(file, lines.join("\n"));
    } else {
      const hiddenLines = new Set((this.settings.hiddenItems[file.path] || []).map((h) => h.line));
      // Only keep items that are still in the file — if user deleted one manually, drop it
      this.settings.hiddenItems[file.path] = (this.settings.hiddenItems[file.path] || []).filter((h) =>
        lines.includes(h.line)
      );
      await this.saveSettings();

      const updated = lines.filter((line) => !hiddenLines.has(line)).join("\n");

      const newChecked = new Set<string>();
      for (const line of updated.split("\n")) {
        if (TASK_CHECKED.test(line)) newChecked.add(line);
      }
      this.knownChecked.set(file.path, newChecked);
      await this.app.vault.modify(file, updated);
    }
  }

  private async snapshotFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const checked = new Set<string>();
    for (const line of content.split("\n")) {
      if (TASK_CHECKED.test(line)) checked.add(line);
    }
    this.knownChecked.set(file.path, checked);
  }

  private async removeCheckedLine(file: TFile, targetLine: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file === file) {
      const editor = view.editor;
      for (let i = 0; i < editor.lineCount(); i++) {
        if (editor.getLine(i) === targetLine) {
          const prevLine = i > 0 ? editor.getLine(i - 1) : null;
          if (this.settings.action === "hide") {
            this.saveHiddenItem(file.path, targetLine, prevLine);
          }
          this.deleteLine(editor, i, targetLine);
          return;
        }
      }
    }

    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const idx = lines.indexOf(targetLine);
    if (idx === -1) return;

    const prevLine = idx > 0 ? lines[idx - 1] : null;
    if (this.settings.action === "hide") {
      this.saveHiddenItem(file.path, targetLine, prevLine);
    }
    lines.splice(idx, 1);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  private saveHiddenItem(filePath: string, line: string, prevLine: string | null) {
    if (!this.settings.hiddenItems[filePath]) {
      this.settings.hiddenItems[filePath] = [];
    }
    const seq = this.settings.hiddenItems[filePath].length;
    this.settings.hiddenItems[filePath].push({ line, prevLine, seq });
    this.saveSettings();
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
    if (!this.settings.hiddenItems) this.settings.hiddenItems = {};
    // Migrate old format (plain strings or missing fields) — just clear invalid entries
    for (const [path, items] of Object.entries(this.settings.hiddenItems)) {
      if (items.length > 0 && (typeof items[0] === "string" || items[0].prevLine === undefined)) {
        this.settings.hiddenItems[path] = [];
      }
    }
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
          .addOption("hide", "Hide (saved, can be restored via ribbon)")
          .addOption("delete", "Delete (permanently removed)")
          .setValue(this.plugin.settings.action)
          .onChange(async (value: string) => {
            this.plugin.settings.action = value as CheckedAction;
            if (value === "delete") {
              this.plugin.settings.hiddenItems = {};
            }
            await this.plugin.saveSettings();
          })
      );
  }
}

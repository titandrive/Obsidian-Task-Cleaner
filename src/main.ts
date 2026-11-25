import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, editorInfoField, setIcon } from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";

type CheckedAction = "hide" | "delete";

/** A checked task taken out of a note: the task line and the lines nested under it. */
interface HiddenItem {
  lines: string[];
  prevLine: string | null; // the line just above it when it was taken out, to put it back there
  seq: number;             // order taken out, to put items back in the right order
}

interface CheckerSettings {
  action: CheckedAction;
  skipResetNotes: boolean;
  hiddenItems: Record<string, HiddenItem[]>;
}

const DEFAULT_SETTINGS: CheckerSettings = {
  action: "hide",
  skipResetNotes: true,
  hiddenItems: {},
};

const DELAY_MS = 500;
/** A checked task line, in any list style: "- [x]", "* [x]", "+ [x]", "1. [x]". */
const CHECKED = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[xX](\])/;
const TASK_RESETTER_MARKER = /\[reset-tasks(?=[\s:\]])/i;

const isChecked = (line: string) => CHECKED.test(line);
const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;

export default class CheckerPlugin extends Plugin {
  settings!: CheckerSettings;
  private ribbonEl!: HTMLElement;
  /** Tasks waiting out the delay, by file path and line text, so one check is acted on once. */
  private pending = new Set<string>();
  /** Set while this plugin edits a note itself, so its own edits aren't taken for checks. */
  private applying = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CheckerSettingTab(this.app, this));

    this.ribbonEl = this.addRibbonIcon("eye-off", "Show hidden items", () => this.toggleShowHidden());
    this.addCommand({
      id: "toggle-hidden-items",
      name: "Show or hide checked items in this note",
      callback: () => this.toggleShowHidden(),
    });

    // A task counts as checked off only when its box goes from [ ] to [x]. Typing or editing a
    // checked line, pasting checked lines, undo, or putting hidden items back don't count.
    this.registerEditorExtension(EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !this.applying) this.onEditorUpdate(update);
    }));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateRibbon()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const items = this.settings.hiddenItems[oldPath];
      if (!items) return;
      delete this.settings.hiddenItems[oldPath];
      this.settings.hiddenItems[file.path] = items;
      this.saveSettings();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!this.settings.hiddenItems[file.path]) return;
      delete this.settings.hiddenItems[file.path];
      this.saveSettings();
    }));
    this.app.workspace.onLayoutReady(() => this.updateRibbon());
  }

  private onEditorUpdate(update: ViewUpdate) {
    const file = update.state.field(editorInfoField, false)?.file;
    if (!file) return;

    const newDoc = update.state.doc;
    const oldDoc = update.startState.doc;
    const back = update.changes.invertedDesc;
    const checked: { text: string; line: number }[] = [];

    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      for (let n = newDoc.lineAt(fromB).number; n <= newDoc.lineAt(toB).number; n++) {
        const line = newDoc.line(n);
        if (!isChecked(line.text)) continue;
        const before = oldDoc.lineAt(back.mapPos(line.from, -1)).text;
        if (before === line.text.replace(CHECKED, "$1 $2")) checked.push({ text: line.text, line: n - 1 });
      }
    });
    if (!checked.length) return;
    if (this.settings.skipResetNotes && TASK_RESETTER_MARKER.test(newDoc.toString())) return;

    for (const { text, line } of checked) {
      const key = `${file.path}\n${text}`;
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      window.setTimeout(() => {
        this.pending.delete(key);
        this.takeOut(file, text, line);
      }, DELAY_MS);
    }
  }

  /** The open editor for this file, if any, so changes keep the cursor and can be undone. */
  private editorFor(file: TFile): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) return view.editor;
    }
    return null;
  }

  /**
   * Takes the checked task (and what's nested under it) out of the note, keeping it for later if
   * hiding. If it was unchecked again in the meantime, it stays.
   */
  private async takeOut(file: TFile, text: string, near: number) {
    const editor = this.editorFor(file);
    const lines = editor ? editor.getValue().split("\n") : (await this.app.vault.read(file)).split("\n");

    // The same text may be on several lines; take the one closest to where it was checked.
    let at = -1;
    lines.forEach((l, i) => { if (l === text && (at === -1 || Math.abs(i - near) < Math.abs(at - near))) at = i; });
    if (at === -1) return;
    const end = blockEnd(lines, at);

    if (this.settings.action === "hide") {
      const items = (this.settings.hiddenItems[file.path] ??= []);
      const seq = items.reduce((m, h) => Math.max(m, h.seq), -1) + 1;
      items.push({ lines: lines.slice(at, end), prevLine: at > 0 ? lines[at - 1] : null, seq });
      await this.saveSettings();
    }

    if (editor) {
      // Remove whole lines; at the end of the note, take the line break before them instead.
      const from = end < lines.length ? { line: at, ch: 0 } : at > 0 ? { line: at - 1, ch: lines[at - 1].length } : { line: 0, ch: 0 };
      const to = end < lines.length ? { line: end, ch: 0 } : { line: end - 1, ch: lines[end - 1].length };
      this.edit(() => editor.replaceRange("", from, to));
    } else {
      await this.app.vault.process(file, (data) => {
        const now = data.split("\n");
        const i = now.indexOf(text);
        if (i === -1) return data;
        now.splice(i, blockEnd(now, i) - i);
        return now.join("\n");
      });
    }
    this.updateRibbon();
  }

  private edit(change: () => void) {
    this.applying = true;
    try { change(); } finally { this.applying = false; }
  }

  /** Whether any of this note's hidden items are back in it (shown). */
  private isShowing(path: string, lines: string[]) {
    const present = new Set(lines);
    return (this.settings.hiddenItems[path] ?? []).some((h) => present.has(h.lines[0]));
  }

  private async toggleShowHidden() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    const items = this.settings.hiddenItems[file.path] ?? [];
    if (!items.length) {
      new Notice("Nothing hidden in this note");
      return;
    }

    const editor = this.editorFor(file);
    const lines = editor ? editor.getValue().split("\n") : (await this.app.vault.read(file)).split("\n");
    let next: string[];

    if (!this.isShowing(file.path, lines)) {
      // Put them back, latest first, so items hidden one after another stack in their old order.
      next = [...lines];
      for (const item of [...items].sort((a, b) => b.seq - a.seq)) {
        const prev = item.prevLine === null ? -1 : next.indexOf(item.prevLine);
        const at = item.prevLine === null ? 0 : prev === -1 ? next.length : blockEnd(next, prev);
        next.splice(at, 0, ...item.lines);
      }
    } else {
      // Hide them again. Ones unchecked while shown become normal tasks; ones deleted are dropped.
      const keep: HiddenItem[] = [];
      next = [...lines];
      for (const item of items) {
        const i = next.indexOf(item.lines[0]);
        if (i === -1 || !isChecked(next[i])) continue;
        const end = blockEnd(next, i);
        keep.push({ ...item, lines: next.slice(i, end), prevLine: i > 0 ? next[i - 1] : null });
        next.splice(i, end - i);
      }
      this.settings.hiddenItems[file.path] = keep;
      if (!keep.length) delete this.settings.hiddenItems[file.path];
      await this.saveSettings();
    }

    if (editor) this.edit(() => replaceLines(editor, lines, next));
    else await this.app.vault.modify(file, next.join("\n"));
    this.updateRibbon(next);
  }

  private async updateRibbon(lines?: string[]) {
    const file = this.app.workspace.getActiveFile();
    let showing = false;
    if (file && this.settings.hiddenItems[file.path]?.length) {
      const editor = this.editorFor(file);
      lines ??= editor ? editor.getValue().split("\n") : (await this.app.vault.cachedRead(file)).split("\n");
      showing = this.isShowing(file.path, lines);
    }
    setIcon(this.ribbonEl, showing ? "eye" : "eye-off");
    this.ribbonEl.setAttribute("aria-label", showing ? "Hide checked items" : "Show hidden items");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Older versions kept one line per item ({ line }); keep those as one-line items.
    for (const [path, items] of Object.entries(this.settings.hiddenItems ?? {})) {
      this.settings.hiddenItems[path] = (items as unknown[]).flatMap((raw, i) => {
        const h = raw as Partial<HiddenItem> & { line?: string };
        const lines = h.lines ?? (typeof h.line === "string" ? [h.line] : null);
        return lines ? [{ lines, prevLine: h.prevLine ?? null, seq: h.seq ?? i }] : [];
      });
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** Replaces only the lines that differ, so the cursor and scroll stay where they were. */
function replaceLines(editor: Editor, old: string[], next: string[]) {
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const end = { line: old.length - 1, ch: old[old.length - 1].length };
  if (tail === 0) {
    // The change reaches the end of the note: replace from the end of the last unchanged line.
    const from = head > 0 ? { line: head - 1, ch: old[head - 1].length } : { line: 0, ch: 0 };
    const rest = next.slice(head);
    editor.replaceRange(head > 0 ? rest.map((l) => "\n" + l).join("") : rest.join("\n"), from, end);
  } else {
    const text = next.slice(head, next.length - tail).map((l) => l + "\n").join("");
    editor.replaceRange(text, { line: head, ch: 0 }, { line: old.length - tail, ch: 0 });
  }
}

/** The line after a task and the lines nested (indented) under it. */
function blockEnd(lines: string[], at: number) {
  const indent = indentOf(lines[at]);
  let end = at + 1;
  while (end < lines.length && lines[end].trim() !== "" && indentOf(lines[end]) > indent) end++;
  return end;
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
      .setDesc("What to do when a todo item is checked off. Anything nested under it goes with it.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hide", "Hide (saved, can be shown again from the sidebar)")
          .addOption("delete", "Delete (removed for good)")
          .setValue(this.plugin.settings.action)
          .onChange(async (value: string) => {
            this.plugin.settings.action = value as CheckedAction;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Leave Task Resetter notes alone")
      .setDesc("Don't hide or delete checked items in notes that have a Task Resetter button ([reset-tasks]).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.skipResetNotes).onChange(async (value) => {
          this.plugin.settings.skipResetNotes = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

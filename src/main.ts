import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, editorInfoField, setIcon } from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { hideBlockInLivePreview } from "./hide-block";
import { BLOCK_START, CHECKED, Entry, blockEnd, isChecked, newlyChecked, parse, replaceLines, serialize, uncheckedCounts } from "./notes";

type CheckedAction = "hide" | "delete";

interface CheckerSettings {
  action: CheckedAction;
  skipResetNotes: boolean;
}

const DEFAULT_SETTINGS: CheckerSettings = {
  action: "hide",
  skipResetNotes: true,
};

/** How earlier versions kept hidden items, in the plugin's data; moved into the notes on load. */
interface OldHiddenItem { lines?: string[]; line?: string; prevLine?: string | null; seq?: number }

const DELAY_MS = 500;
const TASK_RESETTER_MARKER = /\[reset-tasks(?=[\s:\]])/i;

export default class CheckerPlugin extends Plugin {
  settings!: CheckerSettings;
  private ribbonEl!: HTMLElement;
  /** Tasks waiting out the delay, by file path, line and text, so one check is acted on once. */
  private pending = new Set<string>();
  /**
   * Each note's unchecked tasks as last seen on disk, to tell which got checked when a note changes
   * outside the editor (reading view, a task list in another note, an embed, sync).
   */
  private seen = new Map<string, Map<string, number>>();
  /** Set while this plugin edits a note itself, so its own edits aren't taken for checks. */
  private applying = false;

  async onload() {
    const data = (await this.loadData()) ?? {};
    this.settings = { action: data.action ?? DEFAULT_SETTINGS.action, skipResetNotes: data.skipResetNotes ?? DEFAULT_SETTINGS.skipResetNotes };
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
    this.registerEditorExtension(hideBlockInLivePreview);

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateRibbon()));
    this.app.workspace.onLayoutReady(async () => {
      if (data.hiddenItems) await this.moveOldItemsIntoNotes(data.hiddenItems);
      this.updateRibbon();
      await this.lookAtNotes();
      this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.onDiskChange(file); }));
      this.registerEvent(this.app.vault.on("create", (file) => { if (file instanceof TFile) this.onDiskChange(file); }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        const counts = this.seen.get(oldPath);
        this.seen.delete(oldPath);
        if (counts) this.seen.set(file.path, counts);
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => this.seen.delete(file.path)));
    });
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
    this.schedule(file, checked, newDoc.toString());
  }

  /** Remembers the unchecked tasks of every note that has tasks, as a starting point. */
  private async lookAtNotes() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.app.metadataCache.getFileCache(file)?.listItems?.some((i) => i.task !== undefined)) continue;
      this.seen.set(file.path, uncheckedCounts(await this.app.vault.cachedRead(file)));
    }
  }

  /** A note changed on disk: act on tasks checked outside the editor (the editor handles its own). */
  private async onDiskChange(file: TFile) {
    if (file.extension !== "md") return;
    const text = await this.app.vault.cachedRead(file);
    const before = this.seen.get(file.path);
    this.seen.set(file.path, uncheckedCounts(text));
    if (!before || this.applying || this.editorFor(file)) return;
    this.schedule(file, newlyChecked(before, text), text);
  }

  private schedule(file: TFile, checked: { text: string; line: number }[], text: string) {
    if (!checked.length) return;
    if (this.settings.skipResetNotes && TASK_RESETTER_MARKER.test(text)) return;

    for (const { text, line } of checked) {
      const key = `${file.path}\n${line}\n${text}`;
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      window.setTimeout(() => {
        this.pending.delete(key);
        this.takeOut(file, text, line);
      }, DELAY_MS);
    }
  }

  /**
   * The open editor for this file, if any (in live preview or source mode, not reading view), so
   * changes keep the cursor and can be undone.
   */
  private editorFor(file: TFile): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source") return view.editor;
    }
    return null;
  }

  private async read(file: TFile) {
    return this.editorFor(file)?.getValue() ?? this.app.vault.cachedRead(file);
  }

  /** Changes a note's text, in its open editor if it has one, else on disk. null leaves it as is. */
  private async apply(file: TFile, change: (text: string) => string | null) {
    const editor = this.editorFor(file);
    if (editor) {
      const old = editor.getValue();
      const next = change(old);
      if (next === null || next === old) return;
      this.applying = true;
      try { replaceLines(editor, old.split("\n"), next.split("\n")); } finally { this.applying = false; }
    } else {
      await this.app.vault.process(file, (text) => change(text) ?? text);
    }
  }

  /**
   * Takes the checked task (and what's nested under it) out of the note, into the note's hidden
   * items block if hiding. If it was unchecked again in the meantime, it stays.
   */
  private async takeOut(file: TFile, text: string, near: number) {
    await this.apply(file, (content) => {
      const note = parse(content);
      const { body } = note;
      // The same text may be on several lines; take the one closest to where it was checked.
      let at = -1;
      body.forEach((l, i) => { if (l === text && (at === -1 || Math.abs(i - near) < Math.abs(at - near))) at = i; });
      if (at === -1) return null;
      const lines = body.splice(at, blockEnd(body, at) - at);
      if (this.settings.action === "hide") note.entries.push({ kind: "hidden", after: at > 0 ? body[at - 1] : null, lines });
      return serialize(note);
    });
    this.updateRibbon();
  }

  private async toggleShowHidden() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    if (!parse(await this.read(file)).entries.length) {
      new Notice("Nothing hidden in this note");
      return;
    }
    await this.apply(file, (content) => {
      const note = parse(content);
      const { body } = note;
      if (note.entries.some((e) => e.kind === "shown")) {
        // Hide the shown ones again. Ones unchecked while shown stay as normal tasks; ones deleted
        // are dropped.
        note.entries = note.entries.flatMap((e): Entry[] => {
          if (e.kind === "hidden") return [e];
          const i = body.indexOf(e.line);
          if (i === -1 || !isChecked(body[i])) return [];
          const lines = body.splice(i, blockEnd(body, i) - i);
          return [{ kind: "hidden", after: i > 0 ? body[i - 1] : null, lines }];
        });
      } else {
        // Put them back, latest first, so items hidden one after another stack in their old order.
        for (let k = note.entries.length - 1; k >= 0; k--) {
          const e = note.entries[k];
          if (e.kind !== "hidden") continue;
          const prev = e.after === null ? -1 : body.indexOf(e.after);
          const at = e.after === null ? 0 : prev === -1 ? body.length : blockEnd(body, prev);
          body.splice(at, 0, ...e.lines);
          note.entries[k] = { kind: "shown", line: e.lines[0] };
        }
      }
      return serialize(note);
    });
    this.updateRibbon();
  }

  private async updateRibbon() {
    const file = this.app.workspace.getActiveFile();
    const showing = !!file && file.extension === "md" &&
      parse(await this.read(file)).entries.some((e) => e.kind === "shown");
    setIcon(this.ribbonEl, showing ? "eye" : "eye-off");
    this.ribbonEl.setAttribute("aria-label", showing ? "Hide checked items" : "Show hidden items");
  }

  /** Moves hidden items kept by earlier versions (in the plugin's data) into their notes. */
  private async moveOldItemsIntoNotes(old: Record<string, OldHiddenItem[]>) {
    for (const [path, items] of Object.entries(old)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !Array.isArray(items)) continue;
      await this.apply(file, (content) => {
        const note = parse(content);
        const present = new Set(note.body);
        for (const h of [...items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
          const lines = h.lines ?? (typeof h.line === "string" ? [h.line] : null);
          if (!lines?.length) continue;
          // Ones shown at the moment are in the note already.
          note.entries.push(present.has(lines[0]) ? { kind: "shown", line: lines[0] } : { kind: "hidden", after: h.prevLine ?? null, lines });
        }
        return serialize(note);
      });
    }
    await this.saveSettings();
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
      .setDesc(`What to do when a todo item is checked off. Anything nested under it goes with it. Hidden items are kept at the bottom of the note, in a comment block ("${BLOCK_START}") that only shows in source mode.`)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hide", "Hide (kept in the note, can be shown again from the sidebar)")
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

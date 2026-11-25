import { App, Command, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, editorInfoField, setIcon } from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { hideBlockInLivePreview } from "./hide-block";
import { BLOCK_START, CHECKED, deleteCompleted, hideShown, isChecked, newlyChecked, parse, replaceLines, serialize, showAll, takeOutAt, uncheckedCounts } from "./notes";

type CheckedAction = "hide" | "delete";

interface CheckerSettings {
  action: CheckedAction;
  skipResetNotes: boolean;
  delayMs: number;
}

const DEFAULT_SETTINGS: CheckerSettings = {
  action: "hide",
  skipResetNotes: true,
  delayMs: 500,
};

/** The choices for how long a checked task stays before it's hidden or deleted. */
const DELAYS: [number, string][] = [
  [0, "Right away"], [500, "Half a second"], [1000, "1 second"], [2000, "2 seconds"],
  [3000, "3 seconds"], [5000, "5 seconds"], [10000, "10 seconds"], [30000, "30 seconds"],
];

/**
 * A note changing on disk counts as you checking a task only this soon after you last clicked,
 * tapped or typed in Obsidian. Changes that come in by sync (checked on another device) or from
 * outside Obsidian are left alone; the device they were checked on handles them.
 */
const INPUT_WINDOW_MS = 2000;

/** How earlier versions kept hidden items, in the plugin's data; moved into the notes on load. */
interface OldHiddenItem { lines?: string[]; line?: string; prevLine?: string | null; seq?: number }

const TASK_RESETTER_MARKER = /\[reset-tasks(?=[\s:\]])/i;

export default class CheckerPlugin extends Plugin {
  settings!: CheckerSettings;
  /** Tasks waiting out the delay, by file path, line and text, so one check is acted on once. */
  private pending = new Set<string>();
  /**
   * Each note's unchecked tasks as last seen on disk, to tell which got checked when a note changes
   * outside the editor (reading view, a task list in another note, an embed, sync).
   */
  private seen = new Map<string, Map<string, number>>();
  /** Set while this plugin edits a note itself, so its own edits aren't taken for checks. */
  private applying = false;
  /** When you last clicked, tapped or typed in Obsidian. */
  private lastInput = 0;
  private ribbonEl!: HTMLElement;
  private command!: Command;

  async onload() {
    const data = (await this.loadData()) ?? {};
    this.settings = {
      action: data.action ?? DEFAULT_SETTINGS.action,
      skipResetNotes: data.skipResetNotes ?? DEFAULT_SETTINGS.skipResetNotes,
      delayMs: typeof data.delayMs === "number" ? data.delayMs : DEFAULT_SETTINGS.delayMs,
    };
    this.addSettingTab(new CheckerSettingTab(this.app, this));

    // Both say what they'll do in the current note: show its hidden tasks, or hide them again.
    this.ribbonEl = this.addRibbonIcon("circle-dashed", "Show completed tasks", () => this.toggleShowHidden());
    this.command = this.addCommand({
      id: "toggle-hidden-items",
      name: "Show completed tasks",
      callback: () => this.toggleShowHidden(),
    });
    this.addCommand({
      id: "delete-completed-tasks",
      name: "Delete completed tasks",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (this.settings.action !== "hide" || !file || file.extension !== "md") return false;
        if (!checking) this.deleteCompletedTasks(file);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateLabels()));
    const input = () => { this.lastInput = Date.now(); };
    this.registerDomEvent(document, "pointerdown", input, { capture: true });
    this.registerDomEvent(document, "keydown", input, { capture: true });
    // A note opened before its tasks were looked at (Obsidian still indexing at startup) gets looked
    // at now, so a check in reading view is caught the first time.
    this.registerEvent(this.app.workspace.on("file-open", async (file) => {
      if (file?.extension === "md" && !this.seen.has(file.path)) {
        this.seen.set(file.path, uncheckedCounts(await this.app.vault.cachedRead(file)));
      }
    }));

    // A task counts as checked off only when its box goes from [ ] to [x]. Typing or editing a
    // checked line, pasting checked lines, undo, or putting hidden items back don't count.
    this.registerEditorExtension(EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !this.applying) this.onEditorUpdate(update);
    }));
    this.registerEditorExtension(hideBlockInLivePreview);

    this.app.workspace.onLayoutReady(async () => {
      if (data.hiddenItems) await this.moveOldItemsIntoNotes(data.hiddenItems);
      await this.lookAtNotes();
      this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.onDiskChange(file); }));
      this.registerEvent(this.app.vault.on("create", (file) => { if (file instanceof TFile) this.onDiskChange(file); }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        const counts = this.seen.get(oldPath);
        this.seen.delete(oldPath);
        if (counts) this.seen.set(file.path, counts);
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => this.seen.delete(file.path)));
      this.updateLabels();
    });
    addCheckMark(this.ribbonEl);
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
    if (file === this.app.workspace.getActiveFile()) this.updateLabels();
    if (!before || this.applying || this.editorFor(file)) return;
    if (Date.now() - this.lastInput > INPUT_WINDOW_MS) return;
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
      }, this.settings.delayMs);
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
      // The same text may be on several lines; take the one closest to where it was checked.
      let at = -1;
      note.body.forEach((l, i) => { if (l === text && (at === -1 || Math.abs(i - near) < Math.abs(at - near))) at = i; });
      if (at === -1) return null;
      takeOutAt(note, at, this.settings.action === "hide");
      return serialize(note);
    });
    this.updateLabels();
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
      if (note.entries.some((e) => e.kind === "shown")) hideShown(note);
      else showAll(note);
      return serialize(note);
    });
    this.updateLabels();
  }

  /** Deletes the note's completed tasks that Checker keeps, hidden or shown, for good. */
  private async deleteCompletedTasks(file: TFile) {
    let count = 0;
    await this.apply(file, (content) => {
      const note = parse(content);
      count = deleteCompleted(note);
      return count ? serialize(note) : null;
    });
    new Notice(count ? `Deleted ${count} completed task${count === 1 ? "" : "s"}` : "No completed tasks to delete in this note");
    this.updateLabels();
  }

  /**
   * Names the sidebar button and the command for what they'll do in the current note: "Hide" if its
   * hidden tasks are showing (a solid circle), else "Show" (a dashed one).
   */
  private async updateLabels() {
    const file = this.app.workspace.getActiveFile();
    const showing = !!file && file.extension === "md" &&
      parse(await this.read(file)).entries.some((e) => e.kind === "shown");
    const label = showing ? "Hide completed tasks" : "Show completed tasks";
    setIcon(this.ribbonEl, showing ? "circle-check" : "circle-dashed");
    if (!showing) addCheckMark(this.ribbonEl);
    this.ribbonEl.setAttribute("aria-label", label);
    this.command.name = `${this.manifest.name}: ${label}`;
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
          note.entries.push(present.has(lines[0]) ? { kind: "shown", line: lines[0] } : { kind: "hidden", after: h.prevLine ?? null, at: null, lines });
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

/**
 * Turns the circle-dashed icon into a dashed circle with a check (Obsidian's icon set has no
 * circle-dashed-check), with the check mark from circle-check so the two match.
 */
function addCheckMark(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (!svg) return;
  const check = document.createElementNS("http://www.w3.org/2000/svg", "path");
  check.setAttribute("d", "m9 12 2 2 4-4");
  svg.appendChild(check);
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
      .setName("Delay")
      .setDesc("How long a checked item stays before it's hidden or deleted. Unchecking it in that time keeps it.")
      .addDropdown((dropdown) => {
        for (const [ms, label] of DELAYS) dropdown.addOption(String(ms), label);
        const current = this.plugin.settings.delayMs;
        if (!DELAYS.some(([ms]) => ms === current)) dropdown.addOption(String(current), `${current / 1000} seconds`);
        dropdown.setValue(String(current)).onChange(async (value) => {
          this.plugin.settings.delayMs = Number(value);
          await this.plugin.saveSettings();
        });
      });

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

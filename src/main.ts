import { App, Command, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, editorInfoField, normalizePath, setIcon } from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { CHECKED, Entry, HiddenState, IGNORE_KEY, Note, mergeHidden, OLD_IGNORE_KEY, isBlockStart, isIgnored, deleteCompleted, hideShown, isChecked, newlyChecked, parse, purge, replaceLines, serialize, showAll, takeOutAt, uncheckedCounts } from "./notes";

type CheckedAction = "hide" | "delete";

interface TaskCleanerSettings {
  action: CheckedAction;
  skipResetNotes: boolean;
  delayMs: number;
  /** Hidden items older than this many days are dropped; 0 keeps them for good. */
  purgeDays: number;
  /** Each note's hidden items, by the note's path. */
  hidden: Record<string, Entry[]>;
  /** When each note's hidden items last changed, so two devices' settings can be merged. */
  updated: Record<string, number>;
}

const DEFAULT_SETTINGS: TaskCleanerSettings = {
  action: "hide",
  skipResetNotes: true,
  delayMs: 500,
  purgeDays: 30,
  hidden: {},
  updated: {},
};

/** The choices for how long hidden items are kept. */
const PURGES: [number, string][] = [
  [1, "1 day"], [7, "1 week"], [14, "2 weeks"], [30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "Never"],
];

/**
 * The QuickNote Android widget hides tasks too, but can't safely write the settings while Obsidian
 * may be holding them, so it adds them to this file next to them, which is taken in from time to time.
 */
const INBOX = "widget-inbox.json";

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

export default class TaskCleanerPlugin extends Plugin {
  settings!: TaskCleanerSettings;
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
  private ignoreCommand!: Command;

  async onload() {
    const data = (await this.loadData()) ?? {};
    this.settings = {
      action: data.action ?? DEFAULT_SETTINGS.action,
      skipResetNotes: data.skipResetNotes ?? DEFAULT_SETTINGS.skipResetNotes,
      delayMs: typeof data.delayMs === "number" ? data.delayMs : DEFAULT_SETTINGS.delayMs,
      purgeDays: typeof data.purgeDays === "number" ? data.purgeDays : DEFAULT_SETTINGS.purgeDays,
      ...readHidden(data),
    };
    this.addSettingTab(new TaskCleanerSettingTab(this.app, this));

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
    // Says what it'll do in the current note: ignore it, or stop ignoring it.
    this.ignoreCommand = this.addCommand({
      id: "toggle-ignore-note",
      name: "Ignore this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.toggleIgnore(file);
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

    this.app.workspace.onLayoutReady(async () => {
      if (data.hiddenItems) this.takeInOldItems(data.hiddenItems);
      await this.moveBlocksIntoSettings();
      await this.takeInWidgetInbox();
      await this.purgeOld();
      await this.lookAtNotes();
      this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.onDiskChange(file); }));
      this.registerEvent(this.app.vault.on("create", (file) => { if (file instanceof TFile) this.onDiskChange(file); }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        const counts = this.seen.get(oldPath);
        this.seen.delete(oldPath);
        if (counts) this.seen.set(file.path, counts);
        const items = this.settings.hidden[oldPath];
        if (items) {
          delete this.settings.hidden[oldPath];
          this.settings.hidden[file.path] = items;
          this.touch(oldPath);
          this.touch(file.path);
          this.saveSettings();
        }
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => {
        this.seen.delete(file.path);
        if (this.settings.hidden[file.path]) {
          delete this.settings.hidden[file.path];
          this.touch(file.path);
          this.saveSettings();
        }
      }));
      // The widget's hidden tasks: taken in when Obsidian comes to the front, and now and then.
      this.registerDomEvent(window, "focus", () => this.takeInWidgetInbox());
      this.registerInterval(window.setInterval(() => this.takeInWidgetInbox(), 60_000));
      this.registerInterval(window.setInterval(() => this.purgeOld(), 6 * 3_600_000));
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
    if (this.settings.skipResetNotes && this.hasTaskResetter() && TASK_RESETTER_MARKER.test(text)) return;
    if (isIgnored(text)) return;

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
   * Changes a note and its hidden items together. [change] gets the note's lines and items (with any
   * old block in the note moved into the items) and says whether it changed anything.
   */
  private async withNote(file: TFile, change: (note: Note) => boolean) {
    let changed = false;
    await this.apply(file, (content) => {
      const note = parse(content);
      note.entries = [...(this.settings.hidden[file.path] ?? []), ...note.entries.map(stamp)];
      changed = change(note) || note.hadBlock;
      if (!changed) return null;
      if (note.entries.length) this.settings.hidden[file.path] = note.entries;
      else delete this.settings.hidden[file.path];
      this.touch(file.path);
      return serialize({ ...note, entries: [] });
    });
    if (changed) await this.saveSettings();
  }

  /**
   * Takes the checked task (and what's nested under it) out of the note, into its hidden items if
   * hiding. If it was unchecked again in the meantime, it stays.
   */
  private async takeOut(file: TFile, text: string, near: number) {
    await this.withNote(file, (note) => {
      // The same text may be on several lines; take the one closest to where it was checked.
      let at = -1;
      note.body.forEach((l, i) => { if (l === text && (at === -1 || Math.abs(i - near) < Math.abs(at - near))) at = i; });
      if (at === -1) return false;
      takeOutAt(note, at, this.settings.action === "hide");
      return true;
    });
    this.updateLabels();
  }

  private async toggleShowHidden() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    await this.takeInWidgetInbox();
    if (!(this.settings.hidden[file.path]?.length || parse(await this.read(file)).entries.length)) {
      new Notice("Nothing hidden in this note");
      return;
    }
    await this.withNote(file, (note) => {
      if (note.entries.some((e) => e.kind === "shown")) hideShown(note);
      else showAll(note);
      return true;
    });
    this.updateLabels();
  }

  /** Deletes the note's completed tasks that Task Cleaner keeps, hidden or shown, for good. */
  private async deleteCompletedTasks(file: TFile) {
    await this.takeInWidgetInbox();
    let count = 0;
    await this.withNote(file, (note) => {
      count = deleteCompleted(note);
      return count > 0;
    });
    new Notice(count ? `Deleted ${count} completed task${count === 1 ? "" : "s"}` : "No completed tasks to delete in this note");
    this.updateLabels();
  }

  /**
   * Sets or clears task-cleaner-ignore: true in the note's frontmatter. Ignored, Task Cleaner leaves its
   * checked tasks where they are.
   */
  private async toggleIgnore(file: TFile) {
    const ignored = isIgnored(await this.read(file));
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (ignored) { delete fm[IGNORE_KEY]; delete fm[OLD_IGNORE_KEY]; }
      else fm[IGNORE_KEY] = true;
    });
    new Notice(ignored ? "Task Cleaner now tracks this note" : "Task Cleaner now ignores this note");
    window.setTimeout(() => this.updateLabels(), 300);
  }

  /**
   * Names the sidebar button and the command for what they'll do in the current note: "Hide" if its
   * hidden tasks are showing (a solid circle), else "Show" (a dashed one).
   */
  private async updateLabels() {
    const file = this.app.workspace.getActiveFile();
    const text = file && file.extension === "md" ? await this.read(file) : "";
    const showing = !!file && [...(this.settings.hidden[file.path] ?? []), ...parse(text).entries].some((e) => e.kind === "shown");
    this.ignoreCommand.name = `${this.manifest.name}: ${isIgnored(text) ? "Track this note" : "Ignore this note"}`;
    const label = showing ? "Hide completed tasks" : "Show completed tasks";
    setIcon(this.ribbonEl, showing ? "circle-check" : "circle-dashed");
    if (!showing) addCheckMark(this.ribbonEl);
    this.ribbonEl.setAttribute("aria-label", label);
    this.command.name = `${this.manifest.name}: ${label}`;
  }

  /** Hidden items kept by the first versions (one list per note, in the settings) taken in. */
  private takeInOldItems(old: Record<string, OldHiddenItem[]>) {
    for (const [path, items] of Object.entries(old)) {
      if (!Array.isArray(items)) continue;
      const list = (this.settings.hidden[path] ??= []);
      this.touch(path);
      for (const h of [...items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
        const lines = h.lines ?? (typeof h.line === "string" ? [h.line] : null);
        if (lines?.length) list.push({ kind: "hidden", after: h.prevLine ?? null, at: null, lines, hiddenAt: Date.now() });
      }
    }
  }

  /**
   * Notes that still have a hidden-items block at the bottom (from versions that kept them in the
   * note, or the widget before it was updated): its items move into the settings, and the block out
   * of the note.
   */
  private async moveBlocksIntoSettings() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(file);
      if (!text.split("\n").some(isBlockStart)) continue;
      await this.withNote(file, () => false);
    }
    await this.saveSettings();
  }

  /** Takes in tasks the QuickNote widget hid, from its inbox file next to the settings. */
  private async takeInWidgetInbox() {
    const path = normalizePath(`${this.manifest.dir}/${INBOX}`);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return;
    let items: (Entry & { path: string })[] = [];
    try { items = JSON.parse(await adapter.read(path)); } catch { return; }
    await adapter.remove(path);
    if (!Array.isArray(items) || !items.length) return;
    for (const { path: note, ...item } of items) {
      if (typeof note !== "string" || item.kind !== "hidden" || !Array.isArray(item.lines)) continue;
      (this.settings.hidden[note] ??= []).push(stamp(item as Entry));
      this.touch(note);
    }
    await this.saveSettings();
    this.updateLabels();
  }

  /** Drops hidden items older than the purge setting. */
  private async purgeOld() {
    let dropped = 0;
    for (const [path, entries] of Object.entries(this.settings.hidden)) {
      const n = purge(entries, this.settings.purgeDays);
      if (!n) continue;
      dropped += n;
      if (!entries.length) delete this.settings.hidden[path];
      this.touch(path);
    }
    // Times kept for notes with nothing hidden any more are only needed until both devices have
    // synced; after 90 days they go.
    for (const [path, at] of Object.entries(this.settings.updated)) {
      if (!this.settings.hidden[path] && Date.now() - at > 90 * 86_400_000) { delete this.settings.updated[path]; dropped++; }
    }
    if (dropped) await this.saveSettings();
  }

  purgeNow() { return this.purgeOld(); }

  /** Whether the Task Resetter plugin is installed (its notes only need leaving alone then). */
  hasTaskResetter(): boolean {
    // @ts-ignore: not in Obsidian's public API
    return !!this.app.plugins?.manifests?.["task-resetter"];
  }

  /** Notes that this note's hidden items changed now. */
  private touch(path: string) {
    this.settings.updated[path] = Date.now();
  }

  /**
   * Sync brought in the settings from another device: takes its settings, and merges the hidden
   * items note by note (each note's from the device that changed it last), so neither device's
   * changes are lost. If this device had newer ones, they're saved back for the other device.
   */
  async onExternalSettingsChange() {
    const data = (await this.loadData()) ?? {};
    const remote = readHidden(data);
    const merged = mergeHidden({ hidden: this.settings.hidden, updated: this.settings.updated }, remote);
    const changedHere = JSON.stringify(merged) !== JSON.stringify(remote);
    this.settings = {
      action: data.action ?? this.settings.action,
      skipResetNotes: data.skipResetNotes ?? this.settings.skipResetNotes,
      delayMs: typeof data.delayMs === "number" ? data.delayMs : this.settings.delayMs,
      purgeDays: typeof data.purgeDays === "number" ? data.purgeDays : this.settings.purgeDays,
      ...merged,
    };
    if (changedHere) await this.saveSettings();
    this.updateLabels();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** The hidden items and their change times from saved settings (empty if missing or malformed). */
function readHidden(data: Record<string, unknown>): HiddenState {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, never>) : {});
  return { hidden: obj(data.hidden), updated: obj(data.updated) };
}

/** An item with when it was hidden; ones from before that was kept count from now. */
function stamp(e: Entry): Entry {
  return e.hiddenAt === undefined ? { ...e, hiddenAt: Date.now() } : e;
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

class TaskCleanerSettingTab extends PluginSettingTab {
  plugin: TaskCleanerPlugin;

  constructor(app: App, plugin: TaskCleanerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Checked item behavior")
      .setDesc(`What to do when a todo item is checked off. Anything nested under it goes with it. To leave a note alone, add ${IGNORE_KEY}: true to its frontmatter, or run "Ignore this note".`)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hide", "Hide")
          .addOption("delete", "Delete")
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
      .setName("Purge hidden items")
      .setDesc("How long hidden items are kept before they're deleted for good. Items shown in a note at the time stay.")
      .addDropdown((dropdown) => {
        for (const [days, label] of PURGES) dropdown.addOption(String(days), label);
        dropdown.setValue(String(this.plugin.settings.purgeDays)).onChange(async (value) => {
          this.plugin.settings.purgeDays = Number(value);
          await this.plugin.saveSettings();
          await this.plugin.purgeNow();
        });
      });

    if (this.plugin.hasTaskResetter()) new Setting(containerEl)
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

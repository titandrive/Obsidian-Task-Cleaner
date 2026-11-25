/**
 * The note text side of Task Cleaner, with no Obsidian in it (so it can be tested on its own): finding
 * tasks, taking them out and putting them back.
 *
 * A note's hidden items are kept in the plugin's settings. Earlier versions kept them in a block at
 * the bottom of the note, which is still read so it can be moved into the settings:
 *
 *   %% Task Cleaner: hidden items
 *   after: "- [ ] Eggs" @3
 *   - [x] Milk
 *     - [x] brown
 *   shown: "- [x] Call the dentist"
 *   %%
 *
 * "after:" starts a hidden item and says which line it goes back under ("after: top" for the top of
 * the note), and after "@" the line number it was on, to tell copies of that line apart (a blank
 * line, say); the item's lines follow. "shown:" is an item that's back in the note for now, so the
 * next toggle knows to hide it again.
 */

export const BLOCK_START = "%% Task Cleaner: hidden items";
/** The block's first line from when the plugin was called Checker; still read, written anew. */
export const OLD_BLOCK_START = "%% Checker: hidden items";
export const isBlockStart = (line: string) => line.trim() === BLOCK_START || line.trim() === OLD_BLOCK_START;
const BLOCK_END = "%%";

/** A checked task line, in any list style: "- [x]", "* [x]", "+ [x]", "1. [x]". */
export const CHECKED = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[xX](\])/;
export const isChecked = (line: string) => CHECKED.test(line);

/**
 * A note's hidden item: its lines, the line it goes back under (null for the top of the note) and
 * the line number it was on, to tell copies of that line apart; when it was hidden, for purging. A
 * shown one is back in the note for now, so the next toggle hides it again.
 */
export type Entry =
  | { kind: "hidden"; after: string | null; at: number | null; lines: string[]; hiddenAt?: number }
  | { kind: "shown"; line: string; hiddenAt?: number };

export interface Note {
  body: string[];      // the note's lines, without the block
  entries: Entry[];
  hadBlock: boolean;
}

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "    ").length;

/** The line after a task and the lines nested (indented) under it. */
export function blockEnd(lines: string[], at: number) {
  const indent = indentOf(lines[at]);
  let end = at + 1;
  while (end < lines.length && lines[end].trim() !== "" && indentOf(lines[end]) > indent) end++;
  return end;
}

const quote = (line: string | null) => (line === null ? "top" : JSON.stringify(line));
function unquote(text: string): string | null {
  if (text === "top") return null;
  try { const v = JSON.parse(text); if (typeof v === "string") return v; } catch { /* written by hand */ }
  return text;
}

export function parse(text: string): Note {
  const lines = text.split("\n");
  const start = lines.findIndex(isBlockStart);
  if (start === -1) return { body: lines, entries: [], hadBlock: false };
  let end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (end === -1) end = lines.length;

  const entries: Entry[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const after = line.match(/^after: (.*?)(?: @(\d+))?$/);
    const shown = line.match(/^shown: (.*)$/);
    if (after) entries.push({ kind: "hidden", after: unquote(after[1]), at: after[2] ? +after[2] : null, lines: [] });
    else if (shown) entries.push({ kind: "shown", line: unquote(shown[1]) ?? "" });
    else {
      const last = entries[entries.length - 1];
      if (last?.kind === "hidden") last.lines.push(line);
      else if (line.trim()) entries.push({ kind: "hidden", after: null, at: null, lines: [line] });
    }
  }
  const body = [...lines.slice(0, start), ...lines.slice(end + 1)];
  return { body, entries: entries.filter((e) => e.kind === "shown" || e.lines.length), hadBlock: true };
}

/** The note's text: its lines, then the block if it has items (on its own, after a blank line). */
export function serialize(note: Note): string {
  if (!note.entries.length && !note.hadBlock) return note.body.join("\n");
  const body = [...note.body];
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  if (!note.entries.length) return body.join("\n") + "\n";
  const block = note.entries.flatMap((e) => e.kind === "hidden" ? [`after: ${quote(e.after)}${e.at == null ? "" : ` @${e.at}`}`, ...e.lines] : [`shown: ${quote(e.line)}`]);
  return [...body, ...(body.length ? [""] : []), BLOCK_START, ...block, BLOCK_END].join("\n") + "\n";
}

/** A task taken out of a note: its lines, and where it was. */
export interface Taken { lines: string[]; after: string | null; at: number }

/** Takes the task at line [at] (and what's nested under it) out of the note's lines. */
export function takeOutAt(note: Note, at: number, keep: boolean): Taken {
  const lines = note.body.splice(at, blockEnd(note.body, at) - at);
  const taken = { lines, after: at > 0 ? note.body[at - 1] : null, at };
  if (keep) note.entries.push({ kind: "hidden", ...taken, hiddenAt: Date.now() });
  return taken;
}

/** Puts taken-out tasks back into the note's lines where they were, latest first. */
export function putBack(body: string[], taken: Taken[]) {
  for (let k = taken.length - 1; k >= 0; k--) body.splice(placeFor(body, taken[k]), 0, ...taken[k].lines);
}

/**
 * Where a hidden item goes back: under its "after" line, the copy nearest to where it was if that
 * line is in the note more than once; where it was if that line is gone; at the top for "top".
 */
function placeFor(body: string[], e: { after: string | null; at: number | null }) {
  if (e.after === null) return 0;
  let best = -1;
  body.forEach((l, i) => {
    if (l !== e.after) return;
    if (best === -1 || (e.at !== null && Math.abs(i - (e.at - 1)) < Math.abs(best - (e.at - 1)))) best = i;
  });
  if (best !== -1) return blockEnd(body, best);
  return e.at === null ? body.length : Math.min(e.at, body.length);
}

/** Puts the hidden items back in the note, latest first, so ones hidden in a row keep their order. */
export function showAll(note: Note) {
  for (let k = note.entries.length - 1; k >= 0; k--) {
    const e = note.entries[k];
    if (e.kind !== "hidden") continue;
    note.body.splice(placeFor(note.body, e), 0, ...e.lines);
    note.entries[k] = { kind: "shown", line: e.lines[0], hiddenAt: e.hiddenAt };
  }
}

/** Hides the shown items again. Ones unchecked while shown stay as normal tasks; deleted ones are dropped. */
export function hideShown(note: Note) {
  note.entries = note.entries.flatMap((e): Entry[] => {
    if (e.kind === "hidden") return [e];
    const i = note.body.indexOf(e.line);
    if (i === -1 || !isChecked(note.body[i])) return [];
    const lines = note.body.splice(i, blockEnd(note.body, i) - i);
    return [{ kind: "hidden", after: i > 0 ? note.body[i - 1] : null, at: i, lines, hiddenAt: e.hiddenAt ?? Date.now() }];
  });
}

/**
 * Deletes the note's completed tasks for good: the hidden ones from the block, and the ones shown at
 * the moment from the note (with what's nested under them), unless unchecked since. Returns how many.
 */
export function deleteCompleted(note: Note) {
  let count = 0;
  for (const e of note.entries) {
    if (e.kind === "hidden") { count++; continue; }
    const i = note.body.indexOf(e.line);
    if (i === -1 || !isChecked(note.body[i])) continue;
    note.body.splice(i, blockEnd(note.body, i) - i);
    count++;
  }
  note.entries = [];
  return count;
}

/** The hidden items older than [days] (not shown ones), dropped. Returns how many. */
export function purge(entries: Entry[], days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  const before = entries.length;
  const keep = entries.filter((e) => e.kind === "shown" || e.hiddenAt === undefined || now - e.hiddenAt < days * 86_400_000);
  entries.splice(0, entries.length, ...keep);
  return before - keep.length;
}

interface LineEditor {
  replaceRange(text: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void;
}

/** Replaces only the lines that differ, so the cursor and scroll stay where they were. */
export function replaceLines(editor: LineEditor, old: string[], next: string[]) {
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

/** The unchecked task lines in a note's text, as counts by line text. */
export function uncheckedCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (UNCHECKED.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

const UNCHECKED = /^(\s*(?:[-*+]|\d+[.)])\s+\[) (\])/;

/**
 * The tasks checked off between two versions of a note, from how many of each unchecked task there
 * were before ([before]) and the text now: a checked line whose unchecked form there's now one
 * fewer of. Going by counts, not positions, works however the rest of the note changed.
 */
export function newlyChecked(before: Map<string, number>, text: string): { text: string; line: number }[] {
  const now = uncheckedCounts(text);
  const left = new Map<string, number>();
  for (const [line, n] of before) {
    const gone = n - (now.get(line) ?? 0);
    if (gone > 0) left.set(line, gone);
  }
  const found: { text: string; line: number }[] = [];
  if (!left.size) return found;
  text.split("\n").forEach((line, i) => {
    if (!isChecked(line)) return;
    const open = line.replace(CHECKED, "$1 $2");
    const n = left.get(open) ?? 0;
    if (n > 0) { left.set(open, n - 1); found.push({ text: line, line: i }); }
  });
  return found;
}

/** The frontmatter property that makes Task Cleaner leave a note alone. */
export const IGNORE_KEY = "task-cleaner-ignore";
/** The same, from when the plugin was called Checker; still read. */
export const OLD_IGNORE_KEY = "checker-ignore";

/** Whether the note's frontmatter has task-cleaner-ignore: true (or the older checker-ignore: true). */
export function isIgnored(text: string): boolean {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return !!m && new RegExp(`^(?:${IGNORE_KEY}|${OLD_IGNORE_KEY}):\\s*["']?(true|yes)["']?\\s*$`, "im").test(m[1]);
}

/** Hidden items by note, with when each note's list last changed (also for lists now gone). */
export interface HiddenState {
  hidden: Record<string, Entry[]>;
  updated: Record<string, number>;
}

/**
 * Two devices' hidden items, after sync brought in the other's: each note's list from whichever
 * device changed it last. A note whose list was emptied or deleted keeps its time, so the other
 * device's older list doesn't come back.
 */
export function mergeHidden(local: HiddenState, remote: HiddenState): HiddenState {
  const out: HiddenState = { hidden: {}, updated: {} };
  const paths = new Set([...Object.keys(local.hidden), ...Object.keys(local.updated), ...Object.keys(remote.hidden), ...Object.keys(remote.updated)]);
  for (const path of paths) {
    const lt = local.updated[path] ?? 0;
    const rt = remote.updated[path] ?? 0;
    const from = rt > lt ? remote : local;
    const list = from.hidden[path];
    if (list?.length) out.hidden[path] = list;
    if (Math.max(lt, rt) > 0) out.updated[path] = Math.max(lt, rt);
  }
  return out;
}

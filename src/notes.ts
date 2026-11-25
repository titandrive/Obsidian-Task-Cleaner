/**
 * The note text side of Checker, with no Obsidian in it (so it can be tested on its own): finding
 * tasks, and reading and writing the block at the bottom of a note that keeps its hidden items:
 *
 *   %% Checker: hidden items
 *   after: "- [ ] Eggs"
 *   - [x] Milk
 *     - [x] brown
 *   shown: "- [x] Call the dentist"
 *   %%
 *
 * "after:" starts a hidden item and says which line it goes back under ("after: top" for the top of
 * the note); the item's lines follow. "shown:" is an item that's back in the note for now, so the
 * next toggle knows to hide it again.
 */

export const BLOCK_START = "%% Checker: hidden items";
const BLOCK_END = "%%";

/** A checked task line, in any list style: "- [x]", "* [x]", "+ [x]", "1. [x]". */
export const CHECKED = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[xX](\])/;
export const isChecked = (line: string) => CHECKED.test(line);

export type Entry =
  | { kind: "hidden"; after: string | null; lines: string[] }
  | { kind: "shown"; line: string };

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
  const start = lines.findIndex((l) => l.trim() === BLOCK_START);
  if (start === -1) return { body: lines, entries: [], hadBlock: false };
  let end = lines.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (end === -1) end = lines.length;

  const entries: Entry[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const after = line.match(/^after: (.*)$/);
    const shown = line.match(/^shown: (.*)$/);
    if (after) entries.push({ kind: "hidden", after: unquote(after[1]), lines: [] });
    else if (shown) entries.push({ kind: "shown", line: unquote(shown[1]) ?? "" });
    else {
      const last = entries[entries.length - 1];
      if (last?.kind === "hidden") last.lines.push(line);
      else if (line.trim()) entries.push({ kind: "hidden", after: null, lines: [line] });
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
  const block = note.entries.flatMap((e) => e.kind === "hidden" ? [`after: ${quote(e.after)}`, ...e.lines] : [`shown: ${quote(e.line)}`]);
  return [...body, ...(body.length ? [""] : []), BLOCK_START, ...block, BLOCK_END].join("\n") + "\n";
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

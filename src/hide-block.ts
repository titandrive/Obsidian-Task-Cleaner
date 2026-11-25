import { EditorState, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { isBlockStart } from "./notes";

/**
 * The hidden-items block at the bottom of a note, in live preview: hidden (Obsidian shows comments
 * there, faded), skipped over by the cursor, and safe from typing and deleting, so it can't be
 * broken without seeing it. In source mode it's shown and edited like any text; reading view hides
 * comments on its own. Task Cleaner's own changes (not typing) still go through.
 */
export const hideBlockInLivePreview = [
  StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (value, tr: Transaction) =>
      tr.docChanged || tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false)
        ? build(tr.state)
        : value,
    provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
  }),
  EditorState.changeFilter.of((tr) => {
    if (!tr.annotation(Transaction.userEvent)) return true;
    const range = blockRange(tr.startState);
    if (!range) return true;
    // Also the line break after the closing %%, so the next line can't be joined onto it.
    const next = tr.startState.doc.sliceString(range.to, range.to + 1) === "\n" ? 1 : 0;
    return [range.from, range.to + next];
  }),
];

/** The block's range (its first line to its closing %%), in live preview, if it's whole. */
function blockRange(state: EditorState): { from: number; to: number } | null {
  if (!state.field(editorLivePreviewField, false)) return null;
  const doc = state.doc;
  for (let n = doc.lines; n >= 1; n--) {
    if (!isBlockStart(doc.line(n).text)) continue;
    // Only a block with its closing line: without one it would hide the rest of the note, so it's
    // left showing.
    for (let end = n + 1; end <= doc.lines; end++) {
      if (doc.line(end).text.trim() === "%%") return { from: doc.line(n).from, to: doc.line(end).to };
    }
    return null;
  }
  return null;
}

function build(state: EditorState): DecorationSet {
  const range = blockRange(state);
  return range ? Decoration.set([Decoration.replace({ block: true }).range(range.from, range.to)]) : Decoration.none;
}

import { EditorState, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { BLOCK_START } from "./notes";

/**
 * Hides the hidden-items block at the bottom of a note in live preview (Obsidian shows comments
 * there, faded), so it only shows in source mode. Reading view hides comments on its own.
 */
export const hideBlockInLivePreview = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr: Transaction) =>
    tr.docChanged || tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false)
      ? build(tr.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
});

function build(state: EditorState): DecorationSet {
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;
  const doc = state.doc;
  for (let n = doc.lines; n >= 1; n--) {
    if (doc.line(n).text.trim() !== BLOCK_START) continue;
    let end = n + 1;
    while (end <= doc.lines && doc.line(end).text.trim() !== "%%") end++;
    const last = doc.line(Math.min(end, doc.lines));
    return Decoration.set([Decoration.replace({ block: true }).range(doc.line(n).from, last.to)]);
  }
  return Decoration.none;
}

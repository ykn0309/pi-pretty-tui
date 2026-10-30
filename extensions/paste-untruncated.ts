/**
 * Keep pasted text fully editable in the composer.
 *
 * Pi collapses a paste larger than 10 lines or 1000 characters into an atomic
 * marker (`[paste #1 +20 lines]`). The text is not lost — it is held in
 * `editor.pastes` and expanded again on submit — but it cannot be edited: the
 * marker is one segmentation unit, so arrows, backspace and typing treat the
 * whole paste as a single character. There is no setting for this; the
 * threshold is a literal inside `Editor#handlePaste`.
 *
 * Rather than reimplement that method (and inherit the job of tracking its
 * control-byte decoding, tab expansion, non-printable filtering and file-path
 * handling as upstream changes it), this wraps it and substitutes the stored
 * text at the moment the marker would be inserted. Pi's own logic therefore
 * still decides what the pasted content is, the insertion keeps its single undo
 * snapshot, and the cursor lands after the text exactly as it would otherwise.
 *
 * The marker match is deliberately strict: if a future Pi changes the marker
 * format, nothing matches and the original collapse behaviour returns instead of
 * corrupting the paste.
 */
const PASTE_MARKER = /^\[paste #(\d+)(?:\s[^\]]*)?\]$/u;

/**
 * Redirect marker insertion to the stored paste text on `Editor.prototype`.
 * Returns a restore function; calling it is safe whether or not the patch is
 * still installed.
 */
export const patchPasteUntruncated = (editorPrototype: any): (() => void) => {
  const originalHandlePaste = editorPrototype.handlePaste;
  const patchedHandlePaste = function (this: any, text: string) {
    const ownInsert = Object.getOwnPropertyDescriptor(this, "insertTextAtCursorInternal");
    const originalInsert = this.insertTextAtCursorInternal;
    this.insertTextAtCursorInternal = function (this: any, value: string, ...rest: any[]) {
      if (typeof value === "string") {
        const match = PASTE_MARKER.exec(value.trim());
        const stored = match ? this.pastes?.get(Number(match[1])) : undefined;
        if (stored !== undefined) return originalInsert.call(this, stored, ...rest);
      }
      return originalInsert.call(this, value, ...rest);
    };
    try {
      return originalHandlePaste.call(this, text);
    } finally {
      if (ownInsert) Object.defineProperty(this, "insertTextAtCursorInternal", ownInsert);
      else delete this.insertTextAtCursorInternal;
    }
  };
  editorPrototype.handlePaste = patchedHandlePaste;
  return () => {
    if (editorPrototype.handlePaste === patchedHandlePaste) {
      editorPrototype.handlePaste = originalHandlePaste;
    }
  };
};

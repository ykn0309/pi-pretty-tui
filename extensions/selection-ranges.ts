import { randomBytes } from "node:crypto";
import { ProcessTerminal, TuiAltScreen, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

type Span = [number, number];
// Session-local APC annotations travel through opaque Container wrappers as
// zero-width text. They are removed before any terminal write or clipboard use.
const prefix = `\x1b_ppt-select-${randomBytes(6).toString("hex")}:`;
const suffix = "\x1b\\";
const marker = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([0-9,;]*)\x1b\\\\", "g");
let enabled = false;
export const selectionMetadataActive = () => enabled;
export const removeSelectionMetadata = (text: string): string => text.includes(prefix) ? text.replace(marker, "") : text;
const subtract = (spans: Span[], start: number, end: number): Span[] => spans.flatMap(([a, b]) => {
  if (end <= a || start >= b) return [[a, b] as Span];
  const rest: Span[] = [];
  if (a < start) rest.push([a, start]);
  if (end < b) rest.push([end, b]);
  return rest;
});

function ranges(line: string, initial: Span[]): Span[] {
  if (!line.includes(prefix)) return initial;
  let result = initial;
  // An annotation follows its fragment. Its origin therefore survives prefixes
  // added by timelines and horizontal layout without looking up a component.
  for (const match of line.matchAll(marker)) {
    const fields = match[1].split(";");
    const width = Number(fields.shift());
    const origin = visibleWidth(line.slice(0, match.index)) - width;
    if (!Number.isSafeInteger(width) || width < 0 || origin < 0) continue;
    const keep: Span[] = fields.filter(Boolean).map(field => field.split(",").map(Number) as Span);
    if (keep.some(([a, b]) => !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || b > width)) continue;
    let cursor = 0;
    for (const [a, b] of keep) {
      result = subtract(result, origin + cursor, origin + a);
      cursor = b;
    }
    result = subtract(result, origin + cursor, origin + width);
  }
  return result;
}

/** Mark only known plugin decoration. Inner annotations are composed, never
 * inferred from glyphs, so actual box art and code strings remain untouched. */
export function selectableRow(line: string, width: number, keep: Span[]): string {
  if (!enabled || line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return line;
  const composed = ranges(line, keep);
  const plain = removeSelectionMetadata(line);
  return plain + prefix + width + (composed.length ? ";" + composed.map(span => span.join(",")).join(";") : "") + suffix;
}

function scrollBox(root: any, owner: any): any {
  if (!root) return undefined;
  if (root.scrollView === owner) return root;
  for (const child of root.children ?? []) {
    const found = scrollBox(child, owner);
    if (found) return found;
  }
}

function viewportRows(root: any, first: number, last: number): Map<number, Array<{ line: string; x: number; left: number; right: number }>> {
  const result = new Map<number, Array<{ line: string; x: number; left: number; right: number }>>();
  const visit = (box: any) => {
    if (!box?.rect || !box.clip || box.clip.y > last || box.clip.y + box.clip.height <= first) return;
    if (box.children?.length) { for (const child of box.children) visit(child); return; }
    if (!box.lines) return;
    const start = Math.max(first, box.rect.y, box.clip.y);
    const end = Math.min(last + 1, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
    for (let row = start; row < end; row++) {
      const line = box.lines[row - box.rect.y + (box.lineOffset ?? 0)];
      if (!line?.includes(prefix)) continue;
      const records = result.get(row) ?? [];
      records.push({ line, x: box.rect.x, left: Math.max(box.rect.x, box.clip.x),
        right: Math.min(box.rect.x + box.rect.width, box.clip.x + box.clip.width) });
      result.set(row, records);
    }
  };
  visit(root);
  return result;
}

export function installSelectionCopy(): () => void {
  const screen = TuiAltScreen.prototype as any;
  const terminal = ProcessTerminal.prototype as any;
  const key = Symbol.for("pretty-tui.selection-ranges");
  if (screen[key]) return () => {};
  const originalCopy = screen.getActiveSelectionText;
  const originalWrite = terminal.write;
  if (typeof originalCopy !== "function" || typeof originalWrite !== "function") return () => {};
  const copy = function (this: any): string | undefined {
    const selection = this.getSelectionBounds();
    if (!selection) return undefined;
    const lines: string[] | undefined = selection.start.scrollView
      ? scrollBox(this.currentLayout?.root, selection.start.scrollView)?.scrollContentLines
      : this.previousScreen;
    if (!lines) return originalCopy.call(this);
    const viewport = selection.start.scrollView ? undefined
      : viewportRows(this.currentLayout?.root, selection.start.row, selection.end.row);
    const copied: string[] = [];
    for (let row = selection.start.row; row <= selection.end.row; row++) {
      const line = lines[row] ?? "";
      const columns = this.getSelectionColumns(line, row, selection);
      let spans: Span[] = columns.end > columns.start ? [[columns.start, columns.end]] : [];
      let annotated = line.includes(prefix);
      if (annotated) spans = ranges(line, spans);
      for (const record of viewport?.get(row) ?? []) {
        annotated = true;
        const allowed = ranges(record.line, [[0, visibleWidth(record.line)]]);
        let cursor = record.left;
        for (const [a, b] of allowed) {
          spans = subtract(spans, cursor, Math.min(record.right, Math.max(record.left, record.x + a)));
          cursor = Math.max(cursor, Math.min(record.right, record.x + b));
        }
        spans = subtract(spans, cursor, record.right);
      }
      if (annotated && !spans.length) continue;
      copied.push(spans.map(([a, b]) => stripTerminalSequences(sliceByColumn(line, a, Math.max(0, b - a), true))).join("").trimEnd());
    }
    const result = copied.join("\n");
    return result.length ? result : undefined;
  };
  const write = function (this: any, data: string) { return originalWrite.call(this, removeSelectionMetadata(data)); };
  screen[key] = { copy, originalCopy, write, originalWrite };
  screen.getActiveSelectionText = copy;
  terminal.write = write;
  enabled = true;
  return () => {
    enabled = false;
    if (screen.getActiveSelectionText === copy) screen.getActiveSelectionText = originalCopy;
    if (terminal.write === write) terminal.write = originalWrite;
    if (screen[key]?.copy === copy) delete screen[key];
  };
}

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

type Annotation = { width: number; excluded: Span[] };
const decoded = new Map<string, Annotation>();
const encoded = new Map<string, string>();
function annotation(payload: string): Annotation | undefined {
  const cached = decoded.get(payload);
  if (cached) return cached;
  const fields = payload.split(";");
  const width = Number(fields.shift());
  if (!Number.isSafeInteger(width) || width < 0) return undefined;
  const excluded: Span[] = [];
  let cursor = 0;
  for (const field of fields) {
    if (!field) continue;
    const values = field.split(",").map(Number);
    if (values.length !== 2) return undefined;
    const [a, b] = values;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < cursor || b < a || b > width) return undefined;
    if (cursor < a) excluded.push([cursor, a]);
    cursor = b;
  }
  if (cursor < width) excluded.push([cursor, width]);
  const result = { width, excluded };
  if (decoded.size >= 1024) decoded.delete(decoded.keys().next().value!);
  decoded.set(payload, result);
  return result;
}

/** Mark only known plugin decoration. Inner annotations are composed, never
 * inferred from glyphs, so actual box art and code strings remain untouched. */
export function selectableRow(line: string, width: number, keep: Span[]): string {
  if (!enabled || line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return line;
  const payload = width + (keep.length ? ";" + keep.map(([a, b]) => a + "," + b).join(";") : "");
  let tag = encoded.get(payload);
  if (!tag) {
    tag = prefix + payload + suffix;
    if (encoded.size >= 1024) encoded.delete(encoded.keys().next().value!);
    encoded.set(payload, tag);
  }
  return tag + line;
}

function scrollBox(root: any, owner: any): any {
  if (!root) return undefined;
  if (root.scrollView === owner) return root;
  for (const child of root.children ?? []) {
    const found = scrollBox(child, owner);
    if (found) return found;
  }
}

function viewportRows(root: any, first: number, last: number, offsetX = 0, offsetY = 0, offscreen = false): Map<number, Array<{ line: string; x: number; left: number; right: number }>> {
  const result = new Map<number, Array<{ line: string; x: number; left: number; right: number }>>();
  const visit = (box: any) => {
    if (!box?.rect || !box.clip) return;
    const vertical = offscreen ? box.rect : box.clip;
    if (vertical.y + offsetY > last || vertical.y + vertical.height + offsetY <= first) return;
    if (box.children?.length) { for (const child of box.children) visit(child); return; }
    if (!box.lines) return;
    const start = Math.max(first - offsetY, box.rect.y, vertical.y);
    const end = Math.min(last + 1 - offsetY, box.rect.y + box.rect.height, vertical.y + vertical.height);
    for (let row = start; row < end; row++) {
      const line = box.lines[row - box.rect.y + (box.lineOffset ?? 0)];
      if (line === undefined) continue;
      const records = result.get(row + offsetY) ?? [];
      records.push({ line, x: box.rect.x + offsetX, left: Math.max(box.rect.x, box.clip.x) + offsetX,
        right: Math.min(box.rect.x + box.rect.width, box.clip.x + box.clip.width) + offsetX });
      result.set(row + offsetY, records);
    }
  };
  visit(root);
  return result;
}

type Surface = { row: number; col: number; width: number; height: number; lines?: string[] };

/** Capture rows during the native compositor's single render, not by rendering
 * a component again at copy time. Restore the exact previous own descriptor. */
function captureRender(target: any, name: string, receive: (rows: string[]) => void): () => void {
  const method = target?.[name];
  if (typeof method !== "function") return () => {};
  const own = Object.getOwnPropertyDescriptor(target, name);
  const capture = function (this: any, ...args: any[]) {
    const result = method.apply(this, args);
    if (Array.isArray(result)) receive(result);
    return result;
  };
  Object.defineProperty(target, name, { configurable: true, writable: true, value: capture });
  return () => {
    if (target[name] !== capture) return;
    if (own) Object.defineProperty(target, name, own);
    else delete target[name];
  };
}

function excludedColumns(line: string): Span[] {
  if (!line.includes(prefix)) return [];
  const excluded: Span[] = [];
  for (const match of line.matchAll(marker)) {
    const tag = annotation(match[1]);
    if (!tag) continue;
    // A start annotation survives native right-edge clipping. Prefixes are
    // normally only outer annotations and padding, so this stays inexpensive.
    const origin = visibleWidth(line.slice(0, match.index));
    for (const [a, b] of tag.excluded) excluded.push([origin + a, origin + b]);
  }
  return excluded;
}

export function installSelectionCopy(): () => void {
  const screen = TuiAltScreen.prototype as any;
  const terminal = ProcessTerminal.prototype as any;
  const key = Symbol.for("pretty-tui.selection-ranges");
  if (screen[key]) return () => {};
  const originalCopy = screen.getActiveSelectionText;
  const originalWrite = terminal.write;
  const originalOverlays = screen.compositeOverlays;
  const originalFlashes = screen.compositeFlashes;
  if (typeof originalCopy !== "function" || typeof originalWrite !== "function" ||
    typeof originalOverlays !== "function" || typeof originalFlashes !== "function") return () => {};
  const overlays = new WeakMap<object, Surface[]>();
  const flashes = new WeakMap<object, Surface[]>();
  const compositeOverlays = function (this: any, lines: string[], width: number, height: number) {
    if (!this.overlayStack?.length) {
      overlays.delete(this);
      return originalOverlays.call(this, lines, width, height);
    }
    const captured: string[][] = [];
    const restore = captureRender(this, "resolveFakeCursors", rows => captured.push(rows));
    let result: string[];
    try { result = originalOverlays.call(this, lines, width, height); }
    finally { restore(); }
    overlays.set(this, (this.renderedOverlayLayouts ?? []).map((box: Surface, i: number) => ({
      row: box.row, col: box.col, width: box.width, height: box.height, lines: captured[i],
    })));
    return result;
  };
  const compositeFlashes = function (this: any, lines: string[], width: number, height: number) {
    if (Array.isArray(this.flashes?.entries) && this.flashes.entries.length === 0) {
      flashes.delete(this);
      return originalFlashes.call(this, lines, width, height);
    }
    let captured: string[] = [];
    const restore = captureRender(this.flashes, "render", rows => { captured = rows; });
    let result: string[];
    try { result = originalFlashes.call(this, lines, width, height); }
    finally { restore(); }
    flashes.set(this, captured.slice(-height).map((line, row) => ({
      row, col: width - visibleWidth(line), width: visibleWidth(line), height: 1, lines: [line],
    })));
    return result;
  };
  const copy = function (this: any): string | undefined {
    const selection = this.getSelectionBounds();
    if (!selection) return undefined;
    const inScroll = Boolean(selection.start.scrollView);
    const scroll = inScroll ? scrollBox(this.currentLayout?.root, selection.start.scrollView) : undefined;
    const lines: string[] | undefined = inScroll ? scroll?.scrollContentLines : this.previousScreen;
    if (!lines) return originalCopy.call(this);
    const viewport = inScroll
      ? viewportRows(scroll?.children?.[0], selection.start.row, selection.end.row,
        -scroll.rect.x, selection.start.scrollView.scrollTop - scroll.rect.y, true)
      : viewportRows(this.currentLayout?.root, selection.start.row, selection.end.row);
    const surfaces: Surface[] = [];
    if (!inScroll) {
      const jump = this.scrollToEndIndicatorRect;
      if (jump) surfaces.push({ row: jump.row, col: jump.column, width: jump.width, height: 1 });
      surfaces.push(...overlays.get(this) ?? [], ...flashes.get(this) ?? []);
    }
    const copied: string[] = [];
    for (let row = selection.start.row; row <= selection.end.row; row++) {
      const line = lines[row] ?? "";
      const columns = this.getSelectionColumns(line, row, selection);
      // Composited/sliced metadata may no longer describe the full fragment.
      // Prefer current raw leaves whenever layout information is available.
      let excluded = this.currentLayout ? [] as Span[] : excludedColumns(line);
      let annotated = line.includes(prefix);
      const paint = (source: string | undefined, x: number, left: number, right: number) => {
        if (right <= left) return;
        // A later surface replaces lower decoration, including when the later
        // surface is ordinary text with no private annotation at all.
        excluded = subtract(excluded, left, right);
        if (!source?.includes(prefix)) return;
        annotated = true;
        for (const [a, b] of excludedColumns(source)) {
          const start = Math.max(left, x + a), end = Math.min(right, x + b);
          if (end > start) excluded.push([start, end]);
        }
      };
      for (const record of viewport?.get(row) ?? []) paint(record.line, record.x, record.left, record.right);
      for (const surface of surfaces) {
        if (row < surface.row || row >= surface.row + surface.height) continue;
        paint(surface.lines?.[row - surface.row], surface.col,
          Math.max(0, surface.col), Math.min(visibleWidth(line), surface.col + surface.width));
      }
      let spans: Span[] = columns.end > columns.start ? [[columns.start, columns.end]] : [];
      for (const [a, b] of excluded) spans = subtract(spans, a, b);
      if (annotated && !spans.length) continue;
      copied.push(spans.map(([a, b]) => stripTerminalSequences(sliceByColumn(line, a, Math.max(0, b - a), true))).join("").trimEnd());
    }
    const result = copied.join("\n");
    return result.length ? result : undefined;
  };
  const write = function (this: any, data: string) { return originalWrite.call(this, removeSelectionMetadata(data)); };
  const methods = [
    [screen, "getActiveSelectionText", originalCopy, copy],
    [screen, "compositeOverlays", originalOverlays, compositeOverlays],
    [screen, "compositeFlashes", originalFlashes, compositeFlashes],
    [terminal, "write", originalWrite, write],
  ] as const;
  const originalOwn = methods.map(([target, name]) => Object.getOwnPropertyDescriptor(target, name));
  screen[key] = { methods };
  for (const [target, name, , patched] of methods) target[name] = patched;
  enabled = true;
  return () => {
    enabled = false;
    decoded.clear();
    encoded.clear();
    methods.forEach(([target, name, , patched], i) => {
      if (target[name] !== patched) return;
      if (originalOwn[i]) Object.defineProperty(target, name, originalOwn[i]!);
      else delete target[name];
    });
    if (screen[key]?.methods === methods) delete screen[key];
  };
}

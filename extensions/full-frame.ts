import { selectableRow, selectionMetadataActive } from "./selection-ranges.js";
import { cardSurface } from "./card-surface.js";
import { isNativeImageRow, stripAnsiBackgrounds } from "./ansi-style.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type NativeFrame = {
  lines: string[]; sourceRows: Map<number, number>; contentWidth: number; inset: number;
};
const frameCache = new WeakMap<object, {
  title: string; source: string[]; width: number; palette: string; sections: string; frame: NativeFrame;
}>();
export const cardMargin = (width: number) => width >= 20 ? 1 : 0;
export const nativeFrameWidth = (width: number) => {
  const panelWidth = width - cardMargin(width) * 2;
  return panelWidth >= 8 ? panelWidth - 4 : Math.max(1, panelWidth);
};

/** Fill one panel row, preserving foreground styles and reopening after resets. */
export const cardBackground = (line: string, width: number, theme: any, role = "toolPendingBg", borderRole?: string): string => {
  if (isNativeImageRow(line)) return line;
  const content = stripAnsiBackgrounds(line);
  const padded = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
  const surface = cardSurface(theme, borderRole, role);
  const prefix = surface.prefix;
  const reopened = padded.replace(/\x1b\[([0-9:;]*)m/g, (sequence, raw: string) => {
    const fields = raw.split(";");
    let reset = raw === "";
    for (let i = 0; i < fields.length; i++) {
      const code = Number(fields[i].split(":")[0] || 0);
      if (code === 0) reset = true;
      if (!fields[i].includes(":") && (code === 38 || code === 58)) {
        i += fields[i + 1] === "2" ? 4 : fields[i + 1] === "5" ? 2 : 0;
      }
    }
    return reset ? sequence + prefix : sequence;
  });
  return surface.paint(reopened);
};

/** One shared panel for native text, media, thinking, replies and user messages. */
function renderPanel(
  title: string, source: string[], width: number, theme: any,
  sections = new Map<number, { label: string; color: string }>(), cacheOwner?: object,
  titleColor = "text", footer = "", borderColor = "borderMuted", background = "toolPendingBg",
): NativeFrame {
  const palette = ["borderMuted", "text", "accent", "success", "error", titleColor, borderColor]
    .map((role) => theme.fg(role, "x")).join("|") + (theme.bold?.("x") ?? "x") +
    cardSurface(theme, borderColor, background).signature + selectionMetadataActive();
  const sectionKey = titleColor + borderColor + footer + background + JSON.stringify([...sections]);
  const cached = cacheOwner ? frameCache.get(cacheOwner) : undefined;
  if (cached && cached.title === title && cached.width === width && cached.palette === palette && cached.sections === sectionKey &&
    cached.source.length === source.length && cached.source.every((line, i) => line === source[i])) return cached.frame;
  const sourceRows = new Map<number, number>();
  if (width < 8) {
    source.forEach((_, y) => sourceRows.set(y, y));
    return { lines: source.map((row) => cardBackground(row, width, theme, background, borderColor)), sourceRows, contentWidth: Math.max(1, width), inset: 0 };
  }
  const contentWidth = width - 4;
  const border = (s: string) => theme.fg(borderColor, s);
  const plainCaption = truncateToWidth(title, width - 6, "…");
  const caption = theme.fg(titleColor, theme.bold?.(plainCaption) ?? plainCaption);
  const copyRanges: Array<Array<[number, number]>> | undefined = selectionMetadataActive() ? [[]] : undefined;
  const lines = [border("╭─ ") + caption + border(" " + "─".repeat(Math.max(0, width - visibleWidth(plainCaption) - 5)) + "╮")];
  source.forEach((row, sourceY) => {
    const section = sections.get(sourceY);
    if (section) {
      const plainLabel = truncateToWidth(section.label, width - 5, "…");
      const label = theme.fg(section.color, plainLabel);
      sourceRows.set(lines.length, sourceY);
      lines.push(border("├─ ") + label + border(" " + "─".repeat(Math.max(0, width - visibleWidth(plainLabel) - 5)) + "┤"));
      copyRanges?.push([]);
    }
    sourceRows.set(lines.length, sourceY);
    if (isNativeImageRow(row)) { lines.push(row); copyRanges?.push([]); }
    else {
      const content = stripAnsiBackgrounds(row);
      const length = visibleWidth(content);
      lines.push(border("│ ") + content + " ".repeat(Math.max(0, contentWidth - length)) + border(" │"));
      copyRanges?.push([[2, 2 + Math.max(1, Math.min(contentWidth, length))]]);
    }
  });
  const footerFits = footer && visibleWidth(footer) + 6 <= width;
  lines.push(footerFits
    ? border("╰" + "─".repeat(width - visibleWidth(footer) - 5) + " " + footer + " ─╯")
    : border("╰" + "─".repeat(width - 2) + "╯"));
  copyRanges?.push([]);
  // Apply backgrounds before adding this frame's annotations so the width
  // cache doesn't retain an extra marked variant of every newly painted row.
  const frame = { lines: lines.map((line, i) => {
    const painted = cardBackground(line, width, theme, background, borderColor);
    return copyRanges ? selectableRow(painted, width, copyRanges[i]) : painted;
  }), sourceRows, contentWidth, inset: 2 };
  if (cacheOwner) frameCache.set(cacheOwner, { title, source: source.slice(), width, palette, sections: sectionKey, frame });
  return frame;
}

const gutterFrames = new WeakMap<NativeFrame, NativeFrame>();

/** Outer gutters stay on the terminal background, outside the filled panel. */
export function frameNativeRows(
  title: string, source: string[], width: number, theme: any,
  sections = new Map<number, { label: string; color: string }>(), cacheOwner?: object,
  titleColor = "text", footer = "", borderColor = "borderMuted", background = "toolPendingBg",
): NativeFrame {
  const margin = cardMargin(width);
  const frame = renderPanel(title, source, width - margin * 2, theme, sections, cacheOwner,
    titleColor, footer, borderColor, background);
  if (!margin) return frame;
  const cached = gutterFrames.get(frame);
  if (cached) return cached;
  const padded = { ...frame, inset: frame.inset + margin,
    lines: frame.lines.map((line) => isNativeImageRow(line) ? line : selectableRow(" ".repeat(margin) + line + " ".repeat(margin), width, [[margin, width - margin]])),
  };
  gutterFrames.set(frame, padded);
  return padded;
}

const trimmedIndices = (source: string[], start: number, end: number): number[] => {
  // Preserve image reservation rows and internal text blank lines.
  if (!source.slice(start, end).some(isNativeImageRow)) {
    while (start < end && !stripTerminalSequences(source[start]).trim()) start++;
    while (end > start && !stripTerminalSequences(source[end - 1]).trim()) end--;
  }
  return Array.from({ length: end - start }, (_, i) => start + i);
};

/** Keep native call/output content in one panel, divided at its actual boundary. */
export function frameNativeToolRows(
  title: string, source: string[], width: number, theme: any,
  resultStart: number | undefined, resultColor: string, owner: object, footer = "",
): NativeFrame {
  const hasOutput = resultStart !== undefined && resultStart > 0 && resultStart < source.length;
  const indices = width < 8 ? source.map((_, i) => i) : hasOutput
    ? [...trimmedIndices(source, 0, resultStart!), ...trimmedIndices(source, resultStart!, source.length)]
    : trimmedIndices(source, 0, source.length);
  const sections = new Map<number, { label: string; color: string }>();
  if (hasOutput) {
    const output = indices.findIndex((i) => i >= resultStart!);
    if (output >= 0) sections.set(output, { label: "Output", color: resultColor });
  }
  const color = resultColor === "error" || resultColor === "success" ? resultColor : "accent";
  const frame = frameNativeRows(title, indices.map((i) => source[i]), width, theme, sections, owner,
    color, footer, color, resultColor === "error" ? "toolErrorBg" : "toolPendingBg");
  return { ...frame, sourceRows: new Map([...frame.sourceRows].map(([y, i]) => [y, indices[i]])) };
}

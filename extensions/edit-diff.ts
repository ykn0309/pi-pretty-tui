import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { mixColors, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

type Range = [number, number];
type Row = { marker: string; number?: string; text: string; styled: string; changes: Range[] };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => Array.from(segmenter.segment(text), part => part.segment);

// Bounded grapheme LCS: long/unrelated lines fall back to highlighting their
// changed middle. Neither path splits emoji, combining marks or surrogate pairs.
function changedRanges(before: string, after: string): [Range[], Range[]] {
  const a = graphemes(before), b = graphemes(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const removed: Range[] = [], added: Range[] = [];
  const range = (parts: string[], from: number, to: number): Range =>
    [visibleWidth(parts.slice(0, from).join("")), visibleWidth(parts.slice(0, to).join(""))];
  const n = endA - start, m = endB - start;
  if (!n || !m || n * m > 65536) {
    if (n) removed.push(range(a, start, endA));
    if (m) added.push(range(b, start, endB));
    return [removed, added];
  }
  const matrix = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    matrix[i][j] = a[start + i] === b[start + j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { i++; j++; }
    else if (i < n && (j === m || matrix[i + 1][j] >= matrix[i][j + 1])) {
      removed.push(range(a, start + i, start + i + 1));
      i++;
    } else {
      added.push(range(b, start + j, start + j + 1));
      j++;
    }
  }
  const merge = (ranges: Range[]) => ranges.reduce<Range[]>((result, next) => {
    const previous = result[result.length - 1];
    if (previous && previous[1] === next[0]) previous[1] = next[1];
    else result.push(next);
    return result;
  }, []);
  return [merge(removed), merge(added)];
}

export function editDiffLayout(theme: any, diff: string, path?: string) {
  const rows: Row[] = diff.split("\n").map(line => {
    const match = /^([ +\-]) *(\d+) (.*)$/.exec(line);
    const marker = match?.[1] ?? (line.startsWith("+") && !line.startsWith("+++") ? "+" : line.startsWith("-") && !line.startsWith("---") ? "-" : " ");
    const text = (match ? match[3] : /^\s+\.\.\.$/.test(line) ? "..." : line).replace(/\t/g, "   ");
    return { marker, number: match?.[2], text, styled: text, changes: [] };
  });
  // Highlight old/new snippets separately so removed code cannot corrupt the
  // syntax state of the new side. Keep all highlighting in the host's theme.
  const language = path ? getLanguageFromPath(path) : undefined;
  for (const excluded of ["+", "-"]) {
    const side = rows.filter(row => row.marker !== excluded);
    let styled: string[];
    try { styled = highlightCode(side.map(row => row.text).join("\n"), language); }
    catch { styled = side.map(row => row.text); }
    side.forEach((row, index) => {
      if (row.marker !== " " || excluded === "+") row.styled = styled[index] ?? row.text;
    });
  }
  for (let index = 0; index < rows.length;) {
    if (rows[index].marker !== "-") { index++; continue; }
    const removed: Row[] = [], added: Row[] = [];
    while (rows[index]?.marker === "-") removed.push(rows[index++]);
    while (rows[index]?.marker === "+") added.push(rows[index++]);
    // Do not guess a line pairing when a replacement changes the line count.
    if (removed.length === added.length) removed.forEach((row, i) => {
      [row.changes, added[i].changes] = changedRanges(row.text, added[i].text);
    });
  }
  const numberWidth = rows.reduce((width, row) => Math.max(width, row.number?.length ?? 0), 1);
  let index = 0;
  return (_line: string) => {
    const row = rows[index++];
    const color = row.marker === "+" ? "toolDiffAdded" : row.marker === "-" ? "toolDiffRemoved" : "toolDiffContext";
    const background = row.marker === "+" ? "toolSuccessBg" : row.marker === "-" ? "toolErrorBg" : undefined;
    const paint = (text: string) => background && theme.bg ? theme.bg(background, text) : text;
    const changeBackground = background && theme.colors?.[background] && theme.colors?.[color]
      ? mixColors(theme.colors[background], theme.colors[color], 0.3) : undefined;
    const width = visibleWidth(row.text);
    let content = "", cursor = 0;
    for (const [start, end] of row.changes) {
      content += sliceByColumn(row.styled, cursor, start - cursor);
      const changed = sliceByColumn(row.styled, start, end - start);
      // A stronger theme-derived background preserves syntax foregrounds and
      // avoids adding font emphasis to the changed graphemes.
      content += changeBackground && theme.style ? theme.style(changed, { bg: changeBackground }) : paint(changed);
      cursor = end;
    }
    content += sliceByColumn(row.styled, cursor, Math.max(0, width - cursor));
    const gutter = row.number ? `${row.number.padStart(numberWidth)} ${row.marker} ` : " ".repeat(numberWidth + 3);
    return {
      prefix: paint(theme.fg(color, gutter)),
      continuation: paint(" ".repeat(numberWidth + 3)),
      content,
      background: background ? paint : undefined,
    };
  };
}

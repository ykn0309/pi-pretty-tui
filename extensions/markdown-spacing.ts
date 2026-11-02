import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * Transcript Markdown spacing policy. This is the only place that decides list
 * spacing; change the table below to tune it. It applies to every list the same
 * way: unordered or ordered, short or wrapped, nested, task, loose or complex.
 *
 * - Pi's Markdown source and parsed tokens are never changed. Items and token
 *   lists are copied, because Pi caches its parsed tokens between renders.
 * - Only blank rows change. Text, emphasis, wrapping and markers stay Pi's.
 * - A boundary that already has a blank row, from a source blank line or from
 *   Pi itself, does not get a second one.
 * - Callers apply this to transcript Markdown only, so overlays stay native.
 */
export const MARKDOWN_GAP_ROWS = {
  /** A paragraph directly followed by a list. */
  beforeList: 1,
  /** A list directly followed by another block, such as a heading. */
  afterList: 1,
  /** Sibling items, at every nesting depth. */
  betweenItems: 1,
  /** Blocks inside one item, such as its text and its nested list. */
  withinItem: 1,
} as const;

export interface MarkdownBlockToken {
  type: string;
  raw?: string;
  text?: string;
}

export interface MarkdownListItemToken {
  tokens: MarkdownBlockToken[];
}

export interface MarkdownListToken extends MarkdownBlockToken {
  items: MarkdownListItemToken[];
  loose: boolean;
  start?: number | "";
}

const blankRows = (count: number): string[] => Array.from({ length: count }, () => "");

const isBlankRow = (row: string): boolean => stripTerminalSequences(row).trim() === "";

/** Rows to add after a top-level or blockquote block that Pi leaves unspaced. */
export function gapRowsAfterBlock(type: string | undefined, nextType: string | undefined): string[] {
  if (type === "paragraph" && nextType === "list") return blankRows(MARKDOWN_GAP_ROWS.beforeList);
  if (type === "list" && nextType !== undefined && nextType !== "space") {
    return blankRows(MARKDOWN_GAP_ROWS.afterList);
  }
  return [];
}

type ItemTokenOutput = "none" | "blank" | "content";

/**
 * What a token inside a list item emits. Pi draws a `checkbox` as part of the
 * item marker, so it emits nothing; treating it as content would part the marker
 * from its text. An empty `text` still emits a row, but that row is blank.
 */
function itemTokenOutput(token: MarkdownBlockToken): ItemTokenOutput {
  if (token.type === "checkbox" || token.type === "def") return "none";
  if (token.type === "space") return "blank";
  if (token.type === "text" || token.type === "paragraph") {
    return token.text?.trim() ? "content" : "blank";
  }
  if (token.type === "html") return token.raw?.trim() ? "content" : "blank";
  return "content";
}

/**
 * Returns a copy of the item with a gap between adjacent content blocks and with
 * no trailing blank rows. Because no item ends blank, nested lists never end
 * blank either, so the gap after them cannot double. Pi's blocks add their own
 * trailing gap only when told a next token type, and item blocks are not told.
 */
function withItemBlockGaps(item: MarkdownListItemToken): MarkdownListItemToken {
  const tokens: MarkdownBlockToken[] = [];
  let previousOutput: ItemTokenOutput = "none";
  for (const token of item.tokens) {
    const output = itemTokenOutput(token);
    if (previousOutput === "content" && output === "content") {
      for (let row = 0; row < MARKDOWN_GAP_ROWS.withinItem; row += 1) tokens.push({ type: "space" });
    }
    if (output !== "none") previousOutput = output;
    tokens.push(token);
  }
  while (tokens.length > 0 && itemTokenOutput(tokens[tokens.length - 1]) !== "content") tokens.pop();
  return { ...item, tokens };
}

/** Joins rendered items, skipping the gap where a blank row already separates them. */
function joinItems(renderedItems: readonly string[][]): string[] {
  const rows: string[] = [];
  for (const itemRows of renderedItems) {
    const previousRow = rows[rows.length - 1];
    const nextRow = itemRows[0];
    if (previousRow !== undefined && nextRow !== undefined && !isBlankRow(previousRow) && !isBlankRow(nextRow)) {
      rows.push(...blankRows(MARKDOWN_GAP_ROWS.betweenItems));
    }
    rows.push(...itemRows);
  }
  return rows;
}

/**
 * Renders a list one item at a time through Pi's own list renderer, which
 * re-enters this policy for nested lists. `loose` is cleared so that Pi's
 * loose-list gap cannot add to the gap chosen here.
 */
export function renderSpacedList(
  list: MarkdownListToken,
  renderList: (singleItemList: MarkdownListToken) => string[],
): string[] {
  const start = typeof list.start === "number" ? list.start : 1;
  return joinItems(list.items.map((item, index) => renderList({
    ...list,
    start: start + index,
    loose: false,
    items: [withItemBlockGaps(item)],
  })));
}

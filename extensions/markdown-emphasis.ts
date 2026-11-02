/**
 * Foreground colors for Markdown strong and emphasis in the assistant's answer.
 *
 * Pi has no strong or emphasis color token, so these reuse existing ones. Each is
 * read from the active theme on every render, so dark, light, custom themes and
 * `/theme` all apply. `syntaxType` looks like an option for emphasis, but it equals
 * `mdCode` in Pi's built-in themes, which would make emphasis look like inline code.
 */
export const MARKDOWN_EMPHASIS_COLORS = {
  strong: "syntaxNumber",
  em: "warning",
} as const;

type EmphasisType = keyof typeof MARKDOWN_EMPHASIS_COLORS;
type EmphasisColor = (typeof MARKDOWN_EMPHASIS_COLORS)[EmphasisType];
type ChildOwner = EmphasisType | "link";

export interface EmphasisTheme {
  fg(color: EmphasisColor, text: string): string;
}

/** Pi's inline style context: how text is styled, and what restores it after a nested span closes. */
export interface InlineStyleContext {
  applyText: (text: string) => string;
  stylePrefix: string;
}

export interface InlineToken {
  type: string;
  tokens?: InlineToken[];
}

const SENTINEL = "\0";

const isChildOwner = (type: string): type is ChildOwner =>
  type === "strong" || type === "em" || type === "link";

// Pi passes a token's children to renderInlineTokens with the parent's context and
// does not say who the parent was. Keyed by array, so Pi's cached tokens stay unmodified.
const childOwners = new WeakMap<readonly InlineToken[], ChildOwner>();
const nativeContexts = new WeakSet<InlineStyleContext>();
const surroundingContexts = new WeakMap<InlineStyleContext, InlineStyleContext>();

/** Marks a context whose text keeps its own foreground, such as a heading title. */
export function withNativeEmphasis(context: InlineStyleContext): InlineStyleContext {
  nativeContexts.add(context);
  return context;
}

function emphasisContext(
  surrounding: InlineStyleContext,
  color: EmphasisColor,
  theme: EmphasisTheme,
): InlineStyleContext {
  const context: InlineStyleContext = {
    // The inner color wins, so a surrounding default style cannot hide the emphasis color.
    applyText: (text) => surrounding.applyText(theme.fg(color, text)),
    // A nested span's foreground close falls back to the terminal default, so
    // Pi's stylePrefix has to reopen the emphasis color for the text after it.
    stylePrefix: surrounding.stylePrefix + theme.fg(color, SENTINEL).split(SENTINEL)[0],
  };
  surroundingContexts.set(context, surrounding);
  return context;
}

/**
 * Returns the context Pi should use for these tokens. Only the context changes:
 * Pi's own recursion still emits every flag and every nested span.
 *
 * The innermost strong or emphasis sets the foreground. A link label uses the
 * context outside all emphasis, so it keeps Pi's link color, and emphasis inside
 * it stays flags-only for the same reason. Inline code is untouched by contexts.
 */
export function themedInlineContext(
  tokens: readonly InlineToken[],
  context: InlineStyleContext,
  theme: EmphasisTheme,
): InlineStyleContext {
  const owner = childOwners.get(tokens);
  for (const token of tokens) {
    if (token.tokens && isChildOwner(token.type)) childOwners.set(token.tokens, token.type);
  }
  if (!owner || nativeContexts.has(context)) return context;
  const surrounding = surroundingContexts.get(context) ?? context;
  if (owner === "link") return withNativeEmphasis({ ...surrounding });
  return emphasisContext(surrounding, MARKDOWN_EMPHASIS_COLORS[owner], theme);
}

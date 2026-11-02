# Markdown readability

## List spacing

Transcript lists use one blank row around adjacent prose/list boundaries, between sibling items, and between content blocks inside an item. The same policy applies to ordered, unordered, nested, task, loose and complex lists. Existing blank separators are not doubled. Original text, markers, numbering, indentation, and wrapping stay with Pi’s renderer; Markdown outside the transcript retains native spacing.

## Heading colors

H2 uses the active theme's heading foreground (`mdHeading`) and bold, without the old gold/white label background or underline. The other levels keep their differentiated treatments: H1 is framed and underlined, H3 is bold and underlined, H4 is bold, H5 has decorative dashes (when width permits), and H6 uses the theme's quote color and italic. Heading markers stay hidden; original Markdown, inline code/link behavior, wrapping and spacing are preserved. H2 follows theme changes without guessing whether a palette is light or dark. This applies to headings in the main transcript; extension overlays retain Pi's native styling.

## Strong and emphasis colors

Assistant answers color Markdown strong (`**` or `__`) with the active theme's `syntaxNumber` and emphasis (`*` or `_`) with its `warning`, on top of Pi's bold and italic. Pi has no dedicated tokens for these, so the colors follow your theme, including `/theme` changes. With both, as in `***both***` or `**a *b* c**`, text gets both flags and the innermost color.

Inline code and links keep their own colors, including inside emphasis. In all three modes, the Markdown source, parsing, wrapping, headings, code blocks, user messages, thinking, tool output and extension overlays stay as they were.

To keep Pi's bold and italic without color, add this to `pretty-tui.json` and run `/reload`:

```json
{ "markdownEmphasis": "native" }
```

This changes color only. It cannot make text heavier: terminals have no stronger weight than bold, and how bold looks depends on your terminal and font. In Pi's `system` theme with a terminal palette, `syntaxNumber` matches `mdCode`, so code inside strong text is told apart by neither color nor weight. Pi's built-in `dark` and `light` themes use the same color for `warning` and `mdHeading`.

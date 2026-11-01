# Issue #2: plugin-only selection-copy exploration

Status: experimental prototype on `explore/selection-copy`. No Pi files are modified. Not merged, pushed or released.

## Approach

Plugin renderers annotate known selectable ranges with session-local, zero-width APC metadata. The annotation travels with a rendered row through otherwise opaque Container wrappers. It is not inferred from box characters and does not use an extension-global coordinate registry.

- User bubbles, shared card frames, fenced-code frames and the composer mark only known layout chrome and padding.
- Nested frames compose their ranges, preserving actual code, box drawings, indentation and blank body rows.
- Transcript selections use the current ScrollView content lines, as native Pi does.
- Viewport/composer selections use the current layout's raw leaf rows, because screen painting and selection highlighting can discard trailing control sequences. Opaque leaves still contain the row annotations; no original component identity is required.
- Copy retains native endpoint/grapheme calculations and subtracts only marked ranges.
- ProcessTerminal.write removes private annotations before writing. Metadata never enters sessions, tool arguments or results.
- Both prototype patches restore on session shutdown; regular terminal-owned selection is unchanged.

## Validation performed on Pi 1.4.0

`npm test` passes: typecheck, the existing regression suite, real Pi loader coexistence tests and the new selection suite.

The selection suite exercises actual native layout and opaque Containers across clean/compact/full at widths 40/80/140, scroll content coordinates, whole/partial/cross-card selection, backward native mouse gestures, nested frames, raw rounded boxes in user text, literal `│`/`─` and tree art, indentation, blank rows, CJK/emoji grapheme endpoints, code blocks, composer viewport painting, native selection highlighting, and resize. Terminal output filtering and shutdown restoration are asserted.

`npm run test:selection-pty` passes on this machine. It launches the native fullscreen TuiAltScreen with a real ProcessTerminal under a PTY, sends actual SGR mouse bytes, checks clipboard callback text for a user bubble and composer, resizes the terminal, repeats selection, and checks that private metadata never reaches the terminal byte stream. This does not invoke a model or external API.

`git diff --check` and `npm pack --dry-run` pass.

## Initial performance measurements

`npm run bench:selection` is a microbenchmark, not an FPS or terminal rendering benchmark. Seven samples, medians, 300 cards / 6,600 rendered rows:

| Operation | Existing | Prototype |
|---|---:|---:|
| Regenerate every card, without owner caching | 7.02 ms | 34.62 ms |
| Unchanged render with owner caching | 0.26 ms | 0.23 ms |
| Copy all rows | 136.03 ms | 79.31 ms |

The annotated data adds 234,600 bytes (about 35.5 bytes per row) in that workload. Visible rows are byte-identical after removing the private annotations. The copy result is asserted against the original body text.

Copying is not necessarily faster in other workloads: the prototype visits fewer cells here because it skips frame/padding cells. Regenerating the entire long transcript has a measurable cost; caching avoids it when content is unchanged. There is no background polling or retained history of coordinate maps.

## Remaining evaluation before treating this as a complete fix

- Manual acceptance in the user's actual terminal and font setup; PTY tests exercise protocol paths, not GPU glyph rendering.
- More overlay, search/jump-indicator and partially clipped horizontal-layout combinations: viewport exclusion ranges must track whichever surface is actually visible, not a covered underlying frame.
- Long-running streaming sessions and repeated reloads, including other extensions patching the terminal/copy methods.
- Annotation allocation/byte overhead under representative real transcripts, beyond the synthetic benchmark.

These are reasons to keep this isolated as an exploration branch rather than claiming a perfect production fix. OS-terminal-owned selection in regular TUI mode is outside this application's copy path and is not changed.

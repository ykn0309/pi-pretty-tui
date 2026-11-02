# Issue #2: plugin-only selection-copy exploration

Status: experimental prototype on `explore/selection-copy`. Main and the installed extension are unchanged. No installed Pi files are edited; no merge, push or release has been performed.

## Approach

Plugin renderers attach session-local, zero-width APC annotations declaring selectable column intervals. Ordinary box glyphs are never used to infer decoration. Original text, code strings, diagrams and native selection/grapheme boundaries remain authoritative.

Annotations now precede their fragments: trailing markers were lost when an opaque horizontal layout clipped a row. They compose as independent constraints at copy time instead of being parsed and rewritten during every frame render. Encoded and decoded annotation shapes have bounded 1,024-entry caches.

- User bubbles, shared card frames, fenced-code frames, transcript Markdown padding, timeline padding and the composer mark known decoration.
- Scroll selections use native ScrollView content coordinates and current raw layout leaves, including offscreen rows and horizontal child offsets. No component-identity or historical-coordinate registry is needed.
- Viewport/composer selections use the current raw layout leaves because screen painting and highlighting can discard control sequences.
- The overlay and flash compositors are patched to capture their existing render output exactly once, without extra component rendering. Copy applies surfaces in paint order: ordinary text from a top surface overrides lower frame exclusions. Native jump-to-end bounds are handled similarly. Captured rows are held weakly per screen and replaced on each frame.
- ProcessTerminal.write removes private annotations before terminal output. There is no background polling. Tool inputs/results and saved sessions contain no annotation data.
- Prototype methods and inherited/own method descriptors are restored on shutdown. Repeated reloads are tested.

## Bugs found and fixed in this exploration

1. An unframed overlay over the composer's top border copied as empty text because lower chrome was applied to the upper surface. Tests now cover marked/unmarked stacked overlays, clipped overlay height, flashes and native search/jump UI.
2. A horizontal stack hidden inside an opaque Container lost trailing metadata during native clipping, leaving a leading border/margin in copied text. Prefix annotations plus current source-leaf geometry fix both transparent and opaque horizontal layouts.
3. Existing test helpers that only stripped CSI codes counted private APC bytes as visible columns. They now use Pi's full stripTerminalSequences implementation; native copy-button coordinate checks continue passing.

## Validation on Pi 1.4.0

`npm test` passes: typecheck, the original regression suite, real extension-loader coexistence tests and the expanded selection suite.

Selection coverage includes:

- clean/compact/full; widths 40/80/140; opaque native Container wrappers;
- partial, multiline, reversed and cross-card selections; 350 deterministic endpoint cases;
- native scroll-content coordinates, offscreen scrolling, horizontal stacks and vertical clipping;
- nested frames, real rounded boxes in user text, literal `│`/`─`/tree art, indentation, blank body rows, links and CJK/emoji/combining graphemes;
- composer viewport painting, selection highlighting, genuine native mouse handlers, resizing;
- ordinary/marked/stacked/height-clipped overlays, flashes, native search and jump-to-end indicator;
- 250 streaming text updates with alternating widths and five shutdown/reload cycles;
- terminal-output hygiene and complete hook restoration.

`npm run test:selection-pty` passes using native TuiAltScreen and ProcessTerminal in a real PTY, actual SGR mouse bytes, clipboard callback assertions and terminal resize.

`npm run test:selection-cli` additionally passes through the installed **Pi 1.4.0 CLI**, actual extension loading and a newly generated isolated fixture session. It tests user-bubble/composer selection and resize with real mouse protocol input. It does not inspect existing user sessions or invoke a model/API. A probe observes the actual screen and intercepts the native clipboard callback; it does not build the copied text.

`git diff --check` and package dry-run are also checked. PTY tests verify terminal protocol behavior, not a GUI terminal's GPU rendering or the system clipboard backend itself.

## Performance

All numbers are local medians, not a universal speed guarantee. Workload: 300 cards / 6,600 lines.

### Renderer microbenchmark (7 samples)

| Operation | Existing | Current prototype |
|---|---:|---:|
| Regenerate every card, without owner caching | 6.51 ms | 7.94 ms |
| Unchanged owner-cached render | 0.25 ms | 0.22 ms |
| Copy all raw rendered rows | 143.84 ms | 73.35 ms |

The first exploration needed approximately 35 ms for regeneration. Deferring composition to copy and caching annotation shapes reduces that to approximately 8 ms. This trades additional annotation bytes for less rendering CPU.

### Native fullscreen frame path (9 samples, 100×40 viewport)

Includes native layout, viewport painting, row diffing and output filtering into an in-memory terminal sink. It excludes actual OS terminal I/O and GPU work. Streaming modifies the final visible card with follow-end enabled.

| Operation | Existing | Current prototype |
|---|---:|---:|
| New fixture and first paint | 172.435 ms | 176.810 ms |
| Unchanged frame | 0.767 ms | 0.532 ms |
| One visible streaming-card update | 0.639 ms | 0.556 ms |
| Copy all 6,600 scroll rows | 258.957 ms | 195.279 ms |

Submillisecond differences can be noise/JIT effects. Copy is cheaper in this workload partly because decoration/padding cells are skipped; other selections need not be faster.

### Memory

Annotations add **465,600 serialized bytes** in the synthetic card workload (about 71 bytes/row). This is not the total heap overhead.

`npm run bench:selection-memory` uses five fresh processes per mode with explicit GC and distinct source rows. Median retained heap, including rows and relevant caches, was **3,180,688 bytes before** and **5,434,912 bytes after**: roughly **2.25 MB additional heap**. V8 string/cache representation and actual transcript contents affect this estimate; OS terminal and GPU memory are excluded.

## Remaining limits and next acceptance steps

- Manual acceptance in the user's actual terminal and normal workflow remains useful even after CLI/PTY coverage.
- Other extensions can patch the same internal methods. Restoration respects a later wrapper rather than overwriting it, but arbitrary patch order and third-party compositors cannot be guaranteed without testing.
- Upstream layout/compositor changes require compatibility checks. This remains an internal-API-dependent plugin solution.
- Automated streaming/reload stress is finite, not proof of leak-free behavior over days of use.
- Regular-mode OS-terminal-owned text selection is outside Pi's application-managed copy path and is unchanged.

No currently failing scenario remains in the automated covered set. That is stronger evidence than the initial prototype, but not a promise that copying is correct in every conceivable environment. Keep this branch isolated until reviewed and manually accepted.

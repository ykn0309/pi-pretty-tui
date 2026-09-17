# pi-pretty-tui

English | [简体中文](./README.zh-CN.md)

A beautiful, polished TUI for the [Pi coding agent](https://pi.dev/).

## Features

- **Collapsible activity timeline:** instead of filling the conversation with individual calls, all built-in and third-party tools are collected into a single `Running(...)` row while work is in progress and a quiet `Done(...)` row when it finishes. Parent rows count tool calls and thoughts; expanding one reveals ordered tool entries and muted `● Thinking` items, each independently expandable.
- **Useful details on demand:** tool-aware summaries keep paths, commands, results, diffs, file previews, and live shell output concise without removing access to the original content.
- **A cohesive visual finish:** rounded user messages and prompt input, theme-aware colors, a clear Markdown heading hierarchy, cleaner lists, and rounded syntax-highlighted code blocks make the entire TUI feel intentional. In fullscreen, each fenced code block also includes a native-feeling `[Copy]` control.

Pi's built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools receive purpose-built compact views. Every third-party tool automatically receives a consistent compact row; opening it preserves its native renderer while removing conflicting terminal background colors. System errors, steering messages, compaction summaries, and visible assistant text remain visible and create hard group boundaries. Pi's cursor, IME, autocomplete, mouse interaction, and tool execution behavior remain intact.

## Install

```sh
pi install npm:pi-pretty-tui
```

Restart Pi or run `/reload` after installation.

Pi may warn that built-in tools are being overridden. This is expected: pi-pretty-tui re-registers Pi's built-in tools and delegates execution to their original implementations, changing only their TUI renderers.

## Working with tool calls

Click a `Running(...)` or `Done(...)` row to keep it as a parent and reveal tools and muted `● Thinking` entries beneath it. Click an individual tool or thinking child to toggle its complete view, or click the parent again to collapse the whole group. Press `Ctrl+O` at any time to use Pi's global expansion control for all tool output and thinking content.

Informational extension notifications emitted during an activity group are displayed as unindented footnotes below the complete group, so they stay visible without interrupting its tree. Warnings and errors retain Pi's native immediate presentation.

## Rendering modes

The extension supports three persistent rendering modes: `clean` (default), `compact`, and `full`. Run `/pretty-tui` to choose one interactively, or use `/pretty-tui clean`, `/pretty-tui compact`, `/pretty-tui full`, and `/pretty-tui status` directly. The selection is stored in `~/.pi/agent/pretty-tui.json` or under the directory selected by `PI_CODING_AGENT_DIR`.

## Copy code blocks

In fullscreen TUI mode, fenced Markdown code blocks include a clickable `[Copy]` control in the top rule:

```sh
pi --tui-mode fullscreen
```

Clicking it copies only the code content—not the rounded border—through Pi's native fullscreen clipboard path and shows the same transient `Copied!` or `Copy failed` flash used by direct text selection. The control is hidden in regular TUI mode because the terminal keeps mouse input for text selection and scrolling there.

## Development

Run the committed regression suite before changing renderer state or transcript grouping:

```sh
npm install
npm test
```

The suite covers live and restored activity timelines, system/steering/compaction boundaries, built-in and third-party tools, expandable thinking, parallel completion ownership, orphaned calls, duplicate-summary prevention, and fullscreen code-block copy hit regions. GitHub Actions runs the same checks on every push and pull request.

## Compatibility notice

Tool rendering uses Pi's documented extension APIs. Thinking visibility and active-tool state follow Pi's built-in expansion and execution transitions through its exported interactive components. Framing native user messages, rounding the native prompt editor, changing unordered-list markers, and enhancing fenced code blocks require reload-safe runtime patches because Pi does not currently expose public renderer hooks for those presentation details. Markdown parsing, syntax highlighting, and terminal semantic zones remain handled by Pi.

No Pi source files are modified. Runtime patches are removed during session shutdown, but a future Pi release may require this extension to be updated.

## Uninstall

```sh
pi remove npm:pi-pretty-tui
```

Then restart Pi.

## License

MIT

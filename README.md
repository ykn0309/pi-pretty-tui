# pi-pretty-tui

English | [简体中文](./README.zh-CN.md)

A beautiful, polished TUI for the [Pi coding agent](https://pi.dev/).

![pi-pretty-tui preview](./assets/screenshot.png)

## Features

- **Collapsible tool activity:** instead of filling the conversation with individual tool calls, supported tools are collected into a single `Running(...)` row while work is in progress and a quiet `Done(...)` row when it finishes. Click the group to reveal its compact child calls, click any child for full details, and click the parent again to collapse everything.
- **Clear conversation structure:** assistant text, steering messages, and compaction summaries create natural group boundaries, so tool activity stays in the correct transcript position even across long or interrupted tasks. Thinking details remain out of the way until you choose to expand them.
- **Useful details on demand:** tool-aware summaries keep paths, commands, results, diffs, file previews, and live shell output concise without removing access to the original content.
- **A cohesive visual finish:** rounded user messages and prompt input, theme-aware colors, cleaner Markdown lists, and rounded syntax-highlighted code blocks make the entire TUI feel intentional. In fullscreen, each fenced code block also includes a native-feeling `[Copy]` control.

Collapsible grouping covers Pi's built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools. Third-party tools keep their own rendering, and Pi's cursor, IME, autocomplete, mouse interaction, and tool execution behavior remain intact.

## Install

```sh
pi install npm:pi-pretty-tui
```

Restart Pi or run `/reload` after installation.

Pi may warn that built-in tools are being overridden. This is expected: pi-pretty-tui re-registers Pi's built-in tools and delegates execution to their original implementations, changing only their TUI renderers.

## Working with tool calls

Click a `Running(...)` or `Done(...)` row to keep it as a parent and reveal the tools beneath it. Click an individual child to toggle its complete view, or click the parent again to collapse the whole group. Press `Ctrl+O` at any time to use Pi's global expansion control for tool output and thinking content.

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

The suite covers live and restored steering/compaction boundaries, parallel completion ownership, orphaned tool calls, duplicate-summary prevention, and fullscreen code-block copy hit regions. GitHub Actions runs the same checks on every push and pull request.

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

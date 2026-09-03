# pi-pretty-tui

A visual refinement extension for the [Pi coding agent](https://pi.dev/). It provides compact tool-call rendering and cleaner list presentation while preserving Pi's built-in tool behavior.

![pi-pretty-tui preview](./assets/screenshot.png)

## Features

- Compact `Read`, `Bash`, `Edit`, `Write`, `Grep`, `Find`, and `List` calls
- Concise per-tool call and result summaries with expandable details
- Native-style `Write` previews in `full` mode: first 10 lines when collapsed, full content when expanded
- Live `Bash` output in `full` mode: latest 5 lines when collapsed, all available output when expanded
- Switchable `full`, `compact`, and `clean` rendering modes with persistent settings
- Clean mode hides thinking blocks (including Pi's standalone `Thinking...` placeholder) while collapsed and reveals the original thinking content when expanded
- Colored `+added` and `-removed` edit statistics and diffs
- Correct hanging indentation for long paths and wrapped tool output
- Bullet (`•`) markers for unordered Markdown lists

## Install

```sh
pi install npm:pi-pretty-tui
```

Restart Pi or run `/reload` after installation.

Pi may warn that built-in tools are being overridden. This is expected: pi-pretty-tui re-registers Pi's built-in tools and delegates execution to their original implementations, changing only their TUI renderers.

## Rendering modes

Run `/pretty-tui` to choose a mode interactively, or set one directly:

```text
/pretty-tui full
/pretty-tui compact
/pretty-tui clean
/pretty-tui status
```

- `full` (default): preserve each tool's detailed call renderer and normal result preview. Press `Ctrl+O` to expand available output, diffs, and content.
- `compact`: when collapsed, all supported built-in tools use concise one-line call summaries and final result summaries. Long commands, written content, edit diffs, and tool output stay hidden until expanded; press `Ctrl+O` to reveal the full details.
- `clean`: collapse supported tool calls into a single `Running(...)` status; the activity slot shows a tool name as soon as its streamed tool call appears, such as `Running(3 tool calls · Read)`, and remains visible for at least 1 second before changing to `thinking...`. Once settled, the label becomes `Done(...)`. Visible assistant text starts a new tool group, so later calls get a separate status. Collapsed thinking blocks stay hidden without Pi's `Thinking...` placeholder; press `Ctrl+O` to reveal thinking content and normal expanded tool calls/output in transcript order.

Clean mode covers the built-in tools managed by this package: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Third-party tools keep their own rendering.

The selected mode applies immediately and persists in `~/.pi/agent/pretty-tui.json` (or the directory selected by `PI_CODING_AGENT_DIR`).

## Expand tool output

Press `Ctrl+O` (Pi's default `app.tools.expand` keybinding) to show or hide detailed output, edit diffs, complete `Write` content, full tool details, and thinking content in `compact` or `clean` mode.

## Compatibility notice

Tool rendering uses Pi's documented extension APIs. Clean thinking and active-tool state follow Pi's built-in expansion and execution transitions through its exported interactive components. Changing unordered-list markers currently requires runtime patching of an internal `@earendil-works/pi-tui` Markdown renderer method because Pi does not expose a public hook for that presentation detail. Code blocks use Pi's original renderer without modification.

No Pi source files are modified. The list-marker patch is removed during session shutdown, but a future Pi release may require this extension to be updated.

## Uninstall

```sh
pi remove npm:pi-pretty-tui
```

Then restart Pi.

## License

MIT

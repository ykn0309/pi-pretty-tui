import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PrettyTuiMode = "full" | "compact" | "clean";
type PrettyTuiConfig = {
  mode?: PrettyTuiMode;
  /** Legacy location used by the first mode implementation. */
  bash?: {
    mode?: "full" | "compact";
  };
};

const loadConfig = (path: string): PrettyTuiConfig => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/** Polished tool calls and list rendering for Pi's TUI. */
export default function prettyTui(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const configPath = join(getAgentDir(), "pretty-tui.json");
  let config = loadConfig(configPath);
  const configuredMode = config.mode ?? config.bash?.mode;
  let renderMode: PrettyTuiMode = configuredMode === "compact" || configuredMode === "clean"
    ? configuredMode
    : "full";

  const saveRenderMode = (mode: PrettyTuiMode) => {
    config = { ...config, mode };
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  pi.registerCommand("pretty-tui", {
    description: "Configure pi-pretty-tui rendering mode",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "full", label: "full", description: "Full Bash command and live output" },
        { value: "compact", label: "compact", description: "First Bash line and status only" },
        { value: "clean", label: "clean", description: "Hide supported tool rows and show a summary" },
        { value: "status", label: "status", description: "Show the current mode" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      let requested = args.trim().toLowerCase();

      if (!requested) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`pi-pretty-tui mode: ${renderMode}`, "info");
          return;
        }
        const full = `Full — full Bash command and live output${renderMode === "full" ? " (current)" : ""}`;
        const compact = `Compact — first Bash line and status only${renderMode === "compact" ? " (current)" : ""}`;
        const clean = `Clean — hide supported tool rows and show one summary${renderMode === "clean" ? " (current)" : ""}`;
        const selected = await ctx.ui.select("pi-pretty-tui rendering mode", [full, compact, clean]);
        if (!selected) return;
        requested = selected === full ? "full" : selected === compact ? "compact" : "clean";
      }

      if (requested === "status") {
        ctx.ui.notify(`pi-pretty-tui mode: ${renderMode}`, "info");
        return;
      }
      if (requested !== "full" && requested !== "compact" && requested !== "clean") {
        ctx.ui.notify("Usage: /pretty-tui [full|compact|clean|status]", "error");
        return;
      }

      renderMode = requested;
      try {
        saveRenderMode(renderMode);
        ctx.ui.notify(`pi-pretty-tui mode set to: ${renderMode}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Mode changed for this session, but could not save settings: ${message}`, "warning");
      }
    },
  });

  // Pi normalizes unordered-list markers to "-". Replace only that marker;
  // leave code-block rendering entirely to Pi's built-in Markdown renderer.
  const markdownPrototype = Markdown.prototype as any;
  const listPatchKey = Symbol.for("pretty-tui.list-bullets");
  if (!markdownPrototype[listPatchKey]) {
    const originalRenderList = markdownPrototype.renderList;
    const patchedRenderList = function (
      this: any,
      token: any,
      depth: number,
      width: number,
      styleContext?: any,
    ): string[] {
      const originalListBullet = this.theme.listBullet;
      this.theme.listBullet = (marker: string) =>
        originalListBullet(marker.replace(/^- /, "• "));
      try {
        return originalRenderList.call(this, token, depth, width, styleContext);
      } finally {
        this.theme.listBullet = originalListBullet;
      }
    };

    markdownPrototype[listPatchKey] = { originalRenderList, patchedRenderList };
    markdownPrototype.renderList = patchedRenderList;

    pi.on("session_shutdown", () => {
      const patch = markdownPrototype[listPatchKey];
      if (patch?.patchedRenderList === markdownPrototype.renderList) {
        markdownPrototype.renderList = patch.originalRenderList;
      }
      if (patch) delete markdownPrototype[listPatchKey];
    });
  }

  const textContent = (result: any): string =>
    result.content
      ?.filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n") ?? "";

  const nonEmptyLines = (value: string): number =>
    value ? value.split("\n").filter((line) => line.length > 0).length : 0;

  type DisplayValue = string | (() => string);
  type DisplayRow = {
    prefix: DisplayValue;
    continuation?: DisplayValue;
    content: DisplayValue;
  };

  /**
   * Wrap content separately from its prefix. Text's normal word wrapping can
   * leave a bullet by itself and drops tree guides on continuation lines.
   */
  const block = (rows: DisplayRow[]): Component => ({
    render(width: number): string[] {
      const rendered: string[] = [];

      for (const row of rows) {
        const prefix = typeof row.prefix === "function" ? row.prefix() : row.prefix;
        const content = typeof row.content === "function" ? row.content() : row.content;
        const rawContinuation = row.continuation ?? " ".repeat(visibleWidth(prefix));
        const continuation = typeof rawContinuation === "function" ? rawContinuation() : rawContinuation;
        const prefixWidth = Math.max(visibleWidth(prefix), visibleWidth(continuation));
        const contentWidth = Math.max(1, width - prefixWidth);
        const wrapped = wrapTextWithAnsi(content || " ", contentWidth);

        rendered.push(prefix + (wrapped[0] ?? ""));
        for (const line of wrapped.slice(1)) rendered.push(continuation + line);
      }

      return rendered;
    },
    invalidate() {},
  });

  type ToolStatus = "running" | "success" | "error";
  const setStatus = (context: any, status: ToolStatus) => {
    context.state.compactToolStatus = status;
  };

  const callRow = (theme: any, name: string, detail: string, state: any): DisplayRow => ({
    prefix: () => {
      const status = (state.compactToolStatus ?? "running") as ToolStatus;
      const color = status === "success" ? "success" : status === "error" ? "error" : "dim";
      return theme.fg(color, "● ");
    },
    continuation: "  ",
    content:
      theme.fg("accent", theme.bold(name)) +
      theme.fg("dim", "(") +
      theme.fg("text", detail) +
      theme.fg("dim", ")"),
  });

  const call = (theme: any, name: string, detail: string, state: any) =>
    block([callRow(theme, name, detail, state)]);

  const writeCall = (theme: any, path: string, content: string, expanded: boolean, state: any) => {
    const lines = content.replace(/\t/g, "    ").split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const total = lines.length;
    const shown = lines.slice(0, expanded ? total : 10);
    const remaining = total - shown.length;
    const rows: DisplayRow[] = [
      callRow(theme, "Write", `${path} · ${total} ${total === 1 ? "line" : "lines"}`, state),
    ];

    for (let index = 0; index < shown.length; index++) {
      const isLast = index === shown.length - 1 && remaining === 0;
      rows.push({
        prefix: theme.fg("dim", isLast ? "   └ " : "   │ "),
        continuation: theme.fg("dim", "   │ "),
        content: theme.fg("toolOutput", shown[index] || " "),
      });
    }

    if (remaining > 0) {
      rows.push({
        prefix: theme.fg("muted", "   └ "),
        continuation: "     ",
        content: theme.fg("muted", `… ${remaining} more ${remaining === 1 ? "line" : "lines"}`),
      });
    }

    return block(rows);
  };

  const result = (
    theme: any,
    summary: string,
    output = "",
    expanded = false,
    error = false,
    summaryIsStyled = false,
    outputStyle: (line: string) => string = (line) => theme.fg("dim", line),
  ) => {
    const rows: DisplayRow[] = [{
      prefix: theme.fg("dim", "└  "),
      continuation: "   ",
      content: summaryIsStyled ? summary : theme.fg(error ? "error" : "toolOutput", summary),
    }];

    if (expanded && output) {
      const lines = output.split("\n");
      const shown = lines.slice(0, 40);
      for (const line of shown) {
        rows.push({
          prefix: theme.fg("dim", "   │ "),
          continuation: theme.fg("dim", "   │ "),
          content: outputStyle(line || " "),
        });
      }
      if (lines.length > shown.length) {
        rows.push({
          prefix: theme.fg("muted", "   └ "),
          continuation: "     ",
          content: theme.fg("muted", `… ${lines.length - shown.length} more lines`),
        });
      }
    }

    return block(rows);
  };

  const isError = (renderContext: any, output: string): boolean =>
    Boolean(renderContext?.isError) || /^(error|failed|access denied)\b/i.test(output.trim());

  const partialResult = (context: any, theme: any, label: string): Component => {
    setStatus(context, "running");
    return result(theme, label);
  };

  const terminalOutputLines = (output: string): string[] => {
    const lines: string[] = [];
    let current = "";

    for (let index = 0; index < output.length; index++) {
      const char = output[index];
      if (char === "\r") {
        if (output[index + 1] === "\n") {
          lines.push(current);
          current = "";
          index++;
        } else {
          // A bare carriage return redraws the current terminal line. Progress
          // bars such as tqdm use this to update in place.
          current = "";
        }
      } else if (char === "\n") {
        lines.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    if (current) lines.push(current);
    return lines;
  };

  const bashResult = (
    context: any,
    theme: any,
    summary: string,
    output: string,
    expanded: boolean,
    status: ToolStatus,
  ): Component => {
    setStatus(context, status);
    const lines = terminalOutputLines(output);
    const shown = expanded ? lines : lines.slice(-5);
    const omitted = lines.length - shown.length;
    const rows: DisplayRow[] = [{
      prefix: theme.fg("dim", "└  "),
      continuation: "   ",
      content: theme.fg(status === "error" ? "error" : "toolOutput", summary),
    }];

    if (omitted > 0) {
      rows.push({
        prefix: theme.fg("muted", "   │ "),
        continuation: theme.fg("muted", "   │ "),
        content: theme.fg("muted", `… ${omitted} earlier ${omitted === 1 ? "line" : "lines"}`),
      });
    }

    for (let index = 0; index < shown.length; index++) {
      const isLast = index === shown.length - 1;
      rows.push({
        prefix: theme.fg("dim", isLast ? "   └ " : "   │ "),
        continuation: theme.fg("dim", "   │ "),
        content: theme.fg("toolOutput", shown[index] || " "),
      });
    }

    return block(rows);
  };

  const completeStatus = (context: any, output: string): boolean => {
    const failed = isError(context, output);
    setStatus(context, failed ? "error" : "success");
    return failed;
  };

  type ToolSummaryData = { count: number; failed: number };
  const supportedTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  type CleanRunState = {
    activeToolCallId?: string;
    lastCompletedToolCallId?: string;
    count: number;
    failed: number;
    active: boolean;
    settled: boolean;
  };
  const cleanRun: CleanRunState = {
    count: 0,
    failed: 0,
    active: false,
    settled: false,
  };

  const summaryText = (count: number, failed: number): string => {
    const countLabel = `${count} tool ${count === 1 ? "call" : "calls"}`;
    return failed > 0 ? `${countLabel} · ${failed} failed` : countLabel;
  };

  const summaryRow = (theme: any, count: number, failed: number): DisplayRow => ({
    prefix: theme.fg(failed > 0 ? "error" : "success", "● "),
    continuation: "  ",
    content: theme.fg("accent", theme.bold("Tools")) + theme.fg("dim", "(") +
      theme.fg("text", summaryText(count, failed)) + theme.fg("dim", ")"),
  });

  /**
   * Clean mode keeps one live row in the existing tool component. This avoids
   * waiting for agent_end (which can be followed by retry/compaction) and also
   * leaves a visible count while the model is thinking between tool calls.
   */
  const cleanToolCall = (theme: any, name: string, toolCallId: string, state: any): Component => ({
    render(width: number): string[] {
      if (renderMode !== "clean" || cleanRun.settled) return [];

      if (cleanRun.activeToolCallId === toolCallId) {
        return block([{
          prefix: theme.fg("dim", "● "),
          continuation: "  ",
          content: theme.fg("accent", theme.bold(name)) + theme.fg("muted", "…"),
        }]).render(width);
      }

      if (!cleanRun.activeToolCallId && cleanRun.lastCompletedToolCallId === toolCallId && cleanRun.count > 0) {
        return block([summaryRow(theme, cleanRun.count, cleanRun.failed)]).render(width);
      }

      // During the tiny gap before tool_execution_start, retain the natural
      // pending state for a component that Pi has just created.
      if (!cleanRun.activeToolCallId && cleanRun.active &&
          (state.compactToolStatus ?? "running") === "running" && cleanRun.count === 0) {
        return block([{
          prefix: theme.fg("dim", "● "),
          continuation: "  ",
          content: theme.fg("accent", theme.bold(name)) + theme.fg("muted", "…"),
        }]).render(width);
      }

      return [];
    },
    invalidate() {},
  });

  const hiddenToolResult = (context: any, options: any, output: string): Component => {
    if (options.isPartial) setStatus(context, "running");
    else completeStatus(context, output);
    return block([]);
  };

  pi.registerEntryRenderer<ToolSummaryData>("pretty-tui-tool-summary", (entry, { expanded }, theme) => ({
    render(width: number): string[] {
      if (renderMode !== "clean" || expanded) return [];
      const count = entry.data?.count ?? 0;
      const failed = entry.data?.failed ?? 0;
      return block([summaryRow(theme, count, failed)]).render(width);
    },
    invalidate() {},
  }));

  pi.on("agent_start", () => {
    // A retry can start another low-level agent loop. Keep the accumulated
    // count until the whole run reaches agent_settled.
    if (!cleanRun.active) {
      cleanRun.count = 0;
      cleanRun.failed = 0;
      cleanRun.lastCompletedToolCallId = undefined;
      cleanRun.settled = false;
    }
    cleanRun.active = true;
    cleanRun.activeToolCallId = undefined;
  });
  pi.on("tool_execution_start", (event) => {
    if (!supportedTools.has(event.toolName)) return;
    cleanRun.active = true;
    cleanRun.activeToolCallId = event.toolCallId;
  });
  pi.on("tool_execution_end", (event) => {
    if (!supportedTools.has(event.toolName)) return;
    cleanRun.count++;
    if (event.isError) cleanRun.failed++;
    cleanRun.lastCompletedToolCallId = event.toolCallId;
    if (cleanRun.activeToolCallId === event.toolCallId) cleanRun.activeToolCallId = undefined;
  });
  pi.on("agent_end", () => {
    // No summary is appended here: this event may be followed by an automatic
    // retry or compaction. The live row remains available until settled.
    cleanRun.activeToolCallId = undefined;
  });
  pi.on("agent_settled", () => {
    cleanRun.active = false;
    cleanRun.activeToolCallId = undefined;
    cleanRun.settled = true;
    if (renderMode === "clean" && cleanRun.count > 0) {
      pi.appendEntry<ToolSummaryData>("pretty-tui-tool-summary", {
        count: cleanRun.count,
        failed: cleanRun.failed,
      });
    }
  });

  const read = createReadTool(cwd);
  pi.registerTool({
    ...read,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "Read", context.toolCallId, context.state);
      const range = args.offset || args.limit
        ? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`
        : "";
      return call(theme, "Read", `${args.path}${range}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Reading…");
      const image = toolResult.content?.find((item: any) => item.type === "image");
      const failed = completeStatus(context, output);
      if (image) return result(theme, "Read image", "", false, failed);
      const lines = nonEmptyLines(output);
      const truncated = toolResult.details?.truncation?.truncated ? " · truncated" : "";
      return result(
        theme,
        failed ? (output.split("\n")[0] || "Read failed") : `Read ${lines} ${lines === 1 ? "line" : "lines"}${truncated}`,
        output,
        options.expanded,
        failed,
      );
    },
  } as any);

  const bash = createBashTool(cwd);
  pi.registerTool({
    ...bash,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "Bash", context.toolCallId, context.state);
      const command = typeof args.command === "string" ? args.command : "";
      if (renderMode === "compact" && !context.expanded) {
        const commandLines = command.split(/\r\n|\r|\n/);
        const firstLine = commandLines[0] ?? "";
        const omitted = commandLines.length - 1;
        const detail = omitted > 0
          ? `${firstLine} … (${omitted} more ${omitted === 1 ? "line" : "lines"})`
          : firstLine;
        return call(theme, "Bash", detail, context.state);
      }
      return call(theme, "Bash", command, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (renderMode === "compact" && !options.expanded) {
        if (options.isPartial) return partialResult(context, theme, "Running…");
        const failed = completeStatus(context, output);
        return result(theme, failed ? "Command failed" : "Done", "", false, failed);
      }

      if (options.isPartial) {
        return bashResult(context, theme, "Running…", output, options.expanded, "running");
      }

      const failed = isError(context, output);
      const outputLines = terminalOutputLines(output);
      const lineCount = outputLines.filter((line) => line.length > 0).length;
      const summary = failed
        ? outputLines[0] || "Command failed"
        : outputLines.length > 0
          ? `Done · ${lineCount} output ${lineCount === 1 ? "line" : "lines"}`
          : "Done";
      return bashResult(
        context,
        theme,
        summary,
        output,
        options.expanded,
        failed ? "error" : "success",
      );
    },
  } as any);

  const edit = createEditTool(cwd);
  pi.registerTool({
    ...edit,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "Edit", context.toolCallId, context.state);
      const count = Array.isArray(args.edits) ? ` · ${args.edits.length} changes` : "";
      return call(theme, "Edit", `${args.path}${count}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Editing…");
      const failed = completeStatus(context, output);
      const diff = toolResult.details?.diff ?? "";
      const additions = diff.split("\n").filter((line: string) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removals = diff.split("\n").filter((line: string) => line.startsWith("-") && !line.startsWith("---")).length;
      const summary = failed
        ? output.split("\n")[0] || "Edit failed"
        : diff
          ? theme.fg("toolOutput", "Updated · ") +
            theme.fg("success", `+${additions}`) +
            theme.fg("toolOutput", " ") +
            theme.fg("error", `-${removals}`)
          : "Updated";
      return result(
        theme,
        summary,
        diff || output,
        options.expanded,
        failed,
        !failed && Boolean(diff),
        (line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
          if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
          return theme.fg("toolDiffContext", line);
        },
      );
    },
  } as any);

  const write = createWriteTool(cwd);
  pi.registerTool({
    ...write,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "Write", context.toolCallId, context.state);
      const content = typeof args.content === "string" ? args.content : "";
      return writeCall(theme, String(args.path ?? ""), content, context.expanded, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Writing…");
      const failed = completeStatus(context, output);
      return result(
        theme,
        failed ? output.split("\n")[0] || "Write failed" : "Written",
        output,
        options.expanded,
        failed,
      );
    },
  } as any);

  const grep = createGrepTool(cwd);
  pi.registerTool({
    ...grep,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "Grep", context.toolCallId, context.state);
      const where = args.path ? ` · ${args.path}` : "";
      const glob = args.glob ? ` · ${args.glob}` : "";
      return call(theme, "Grep", `${args.pattern}${where}${glob}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Searching…");
      const failed = completeStatus(context, output);
      const matches = nonEmptyLines(output);
      return result(theme, failed ? output.split("\n")[0] : `Found ${matches} matches`, output, options.expanded, failed);
    },
  } as any);

  const find = createFindTool(cwd);
  pi.registerTool({
    ...find,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "Find", context.toolCallId, context.state);
      return call(theme, "Find", `${args.pattern}${args.path ? ` · ${args.path}` : ""}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Searching…");
      const failed = completeStatus(context, output);
      const matches = nonEmptyLines(output);
      return result(theme, failed ? output.split("\n")[0] : `Found ${matches} paths`, output, options.expanded, failed);
    },
  } as any);

  const ls = createLsTool(cwd);
  pi.registerTool({
    ...ls,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (renderMode === "clean" && !context.expanded) return cleanToolCall(theme, "List", context.toolCallId, context.state);
      return call(theme, "List", args.path ?? ".", context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (renderMode === "clean" && !options.expanded) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Listing…");
      const failed = completeStatus(context, output);
      const entries = nonEmptyLines(output);
      return result(theme, failed ? output.split("\n")[0] : `Listed ${entries} entries`, output, options.expanded, failed);
    },
  } as any);
}

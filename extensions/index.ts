import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Polished tool calls and list rendering for Pi's TUI. */
export default function prettyTui(pi: ExtensionAPI) {
  const cwd = process.cwd();

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

  const completeStatus = (context: any, output: string): boolean => {
    const failed = isError(context, output);
    setStatus(context, failed ? "error" : "success");
    return failed;
  };

  const read = createReadTool(cwd);
  pi.registerTool({
    ...read,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const range = args.offset || args.limit
        ? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`
        : "";
      return call(theme, "Read", `${args.path}${range}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Reading…");
      const output = textContent(toolResult);
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
      const command = String(args.command).replace(/\s*\n\s*/g, " ↵ ");
      return call(theme, "Bash", command, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Running…");
      const output = textContent(toolResult);
      const failed = completeStatus(context, output);
      const lines = nonEmptyLines(output);
      const summary = failed
        ? output.split("\n")[0] || "Command failed"
        : output
          ? `Done · ${lines} output ${lines === 1 ? "line" : "lines"}`
          : "Done";
      return result(theme, summary, output, options.expanded, failed);
    },
  } as any);

  const edit = createEditTool(cwd);
  pi.registerTool({
    ...edit,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const count = Array.isArray(args.edits) ? ` · ${args.edits.length} changes` : "";
      return call(theme, "Edit", `${args.path}${count}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Editing…");
      const output = textContent(toolResult);
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
      const content = typeof args.content === "string" ? args.content : "";
      return writeCall(theme, String(args.path ?? ""), content, context.expanded, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Writing…");
      const output = textContent(toolResult);
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
      const where = args.path ? ` · ${args.path}` : "";
      const glob = args.glob ? ` · ${args.glob}` : "";
      return call(theme, "Grep", `${args.pattern}${where}${glob}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Searching…");
      const output = textContent(toolResult);
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
      return call(theme, "Find", `${args.pattern}${args.path ? ` · ${args.path}` : ""}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Searching…");
      const output = textContent(toolResult);
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
      return call(theme, "List", args.path ?? ".", context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      if (options.isPartial) return partialResult(context, theme, "Listing…");
      const output = textContent(toolResult);
      const failed = completeStatus(context, output);
      const entries = nonEmptyLines(output);
      return result(theme, failed ? output.split("\n")[0] : `Listed ${entries} entries`, output, options.expanded, failed);
    },
  } as any);
}

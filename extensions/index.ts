import {
  AssistantMessageComponent,
  InteractiveMode,
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
  let cleanToolsExpanded = false;

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

  // Pi's built-in assistant component turns hidden thinking into a static
  // "Thinking..." label. In clean mode, completed messages should omit that
  // block entirely, while an active stream still gets the progress label. The
  // component is exported by Pi specifically for extension-level rendering
  // customizations, so patch its public methods rather than Pi's source.
  const assistantPrototype = AssistantMessageComponent.prototype as any;
  const thinkingPatchKey = Symbol.for("pretty-tui.clean-thinking");
  if (!assistantPrototype[thinkingPatchKey]) {
    const originalUpdateContent = assistantPrototype.updateContent;
    const originalRender = assistantPrototype.render;
    const originalMessageKey = Symbol("pretty-tui.original-assistant-message");
    const renderedModeKey = Symbol("pretty-tui.rendered-assistant-mode");
    const renderedExpansionKey = Symbol("pretty-tui.rendered-thinking-expansion");

    const patchedUpdateContent = function (this: any, message: any, isStreaming = this.isStreaming) {
      if (renderMode !== "clean") {
        originalUpdateContent.call(this, message, isStreaming);
        this[originalMessageKey] = message;
        this[renderedModeKey] = renderMode;
        this[renderedExpansionKey] = undefined;
        return;
      }

      const showThinking = cleanToolsExpanded;
      const content = Array.isArray(message?.content) ? message.content : [];
      const lastVisibleContent = [...content].reverse().find((item: any) =>
        (item.type === "text" && typeof item.text === "string" && item.text.trim()) ||
        (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) ||
        item.type === "toolCall",
      );
      const thinkingInProgress = isStreaming && !showThinking && lastVisibleContent?.type === "thinking";
      const displayMessage = !showThinking && !thinkingInProgress
        ? { ...message, content: content.filter((item: any) => item.type !== "thinking") }
        : message;
      const previousHideThinkingBlock = this.hideThinkingBlock;
      // Only an active, collapsed thinking stream gets the progress label.
      // Once text or a tool call follows, remove the historical block instead
      // of leaving a stale "Thinking..." label beside the response.
      this.hideThinkingBlock = thinkingInProgress;
      try {
        originalUpdateContent.call(this, displayMessage, isStreaming);
      } finally {
        this.hideThinkingBlock = previousHideThinkingBlock;
      }

      // Pi's invalidate()/setHideThinkingBlock() call updateContent with
      // lastMessage, so retain the unfiltered message for later mode changes.
      this[originalMessageKey] = message;
      this[renderedModeKey] = renderMode;
      this[renderedExpansionKey] = showThinking;
      this.lastMessage = message;
    };

    const patchedRender = function (this: any, width: number): string[] {
      const needsRefresh = this[originalMessageKey] && (
        this[renderedModeKey] !== renderMode ||
        (renderMode === "clean" && this[renderedExpansionKey] !== cleanToolsExpanded)
      );
      if (needsRefresh) {
        patchedUpdateContent.call(this, this[originalMessageKey], this.isStreaming);
      }
      return originalRender.call(this, width);
    };

    assistantPrototype[thinkingPatchKey] = {
      originalUpdateContent,
      patchedUpdateContent,
      originalRender,
      patchedRender,
    };
    assistantPrototype.updateContent = patchedUpdateContent;
    assistantPrototype.render = patchedRender;

    pi.on("session_shutdown", () => {
      const patch = assistantPrototype[thinkingPatchKey];
      if (!patch) return;
      if (patch.patchedUpdateContent === assistantPrototype.updateContent) {
        assistantPrototype.updateContent = patch.originalUpdateContent;
      }
      if (patch.patchedRender === assistantPrototype.render) {
        assistantPrototype.render = patch.originalRender;
      }
      if (
        assistantPrototype.updateContent === patch.originalUpdateContent &&
        assistantPrototype.render === patch.originalRender
      ) {
        delete assistantPrototype[thinkingPatchKey];
      }
    });
  }

  // Extension shortcuts cannot replace Pi's built-in Ctrl+O binding. Wrap
  // the exported state transition instead, so both Ctrl+O and UI callers keep
  // their normal behavior while clean thinking follows the same state.
  const interactiveModePrototype = InteractiveMode.prototype as any;
  const toolsExpansionPatchKey = Symbol.for("pretty-tui.clean-tool-expansion");
  if (!interactiveModePrototype[toolsExpansionPatchKey]) {
    const originalSetToolsExpanded = interactiveModePrototype.setToolsExpanded;
    const patchedSetToolsExpanded = function (this: any, expanded: boolean) {
      cleanToolsExpanded = expanded;
      return originalSetToolsExpanded.call(this, expanded);
    };

    interactiveModePrototype[toolsExpansionPatchKey] = {
      originalSetToolsExpanded,
      patchedSetToolsExpanded,
    };
    interactiveModePrototype.setToolsExpanded = patchedSetToolsExpanded;

    pi.on("session_shutdown", () => {
      const patch = interactiveModePrototype[toolsExpansionPatchKey];
      if (!patch) return;
      if (patch.patchedSetToolsExpanded === interactiveModePrototype.setToolsExpanded) {
        interactiveModePrototype.setToolsExpanded = patch.originalSetToolsExpanded;
      }
      if (interactiveModePrototype.setToolsExpanded === patch.originalSetToolsExpanded) {
        delete interactiveModePrototype[toolsExpansionPatchKey];
      }
    });
  }

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

  type ToolSummaryGroup = {
    count: number;
    failed: number;
    lastToolCallId: string;
  };
  type ToolSummaryData = {
    count?: number;
    failed?: number;
    /** Identifies the last tool component for older single-group entries. */
    lastToolCallId?: string;
    /** All groups from a run, used to restore summaries after reload. */
    groups?: ToolSummaryGroup[];
  };
  const supportedTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const settledSummaries = new Map<string, { count: number; failed: number }>();
  const legacySummaryLastToolCallIds = new Map<string, string>();
  const knownToolCallIds = new Set<string>();
  type CleanRunState = {
    activeToolCallId?: string;
    lastCompletedToolCallId?: string;
    count: number;
    failed: number;
    groups: ToolSummaryGroup[];
    active: boolean;
    settled: boolean;
  };
  const cleanRun: CleanRunState = {
    count: 0,
    failed: 0,
    groups: [],
    active: false,
    settled: false,
  };

  const finishCleanGroup = () => {
    if (cleanRun.lastCompletedToolCallId && cleanRun.count > 0) {
      const group: ToolSummaryGroup = {
        count: cleanRun.count,
        failed: cleanRun.failed,
        lastToolCallId: cleanRun.lastCompletedToolCallId,
      };
      cleanRun.groups.push(group);
      settledSummaries.set(group.lastToolCallId, {
        count: group.count,
        failed: group.failed,
      });
    }
    cleanRun.count = 0;
    cleanRun.failed = 0;
    cleanRun.lastCompletedToolCallId = undefined;
    cleanRun.activeToolCallId = undefined;
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
   * Clean mode keeps summaries in the existing tool components. This avoids
   * waiting for agent_end (which can be followed by retry/compaction), leaves
   * a visible count between calls, and lets the active tool use full rendering.
   */
  const cleanToolCall = (theme: any, name: string, toolCallId: string): Component => {
    knownToolCallIds.add(toolCallId);
    return {
      render(width: number): string[] {
        if (renderMode !== "clean") return [];

        const settledSummary = settledSummaries.get(toolCallId);
        if (settledSummary) {
          return block([summaryRow(theme, settledSummary.count, settledSummary.failed)]).render(width);
        }
        if (cleanRun.settled) return [];

        if (cleanRun.activeToolCallId === toolCallId) {
          return block([{
            prefix: theme.fg("dim", "● "),
            continuation: "  ",
            content: theme.fg("accent", theme.bold(name)) + theme.fg("muted", "…"),
          }]).render(width);
        }

        // Keep the latest completed portion visible while the next tool is
        // running; its component will be replaced by the merged summary when
        // that next tool finishes.
        if (cleanRun.lastCompletedToolCallId === toolCallId && cleanRun.count > 0) {
          return block([summaryRow(theme, cleanRun.count, cleanRun.failed)]).render(width);
        }

        // Do not fall back to the per-component pending state here: Pi may
        // create several tool-call components before execution starts, and
        // showing that fallback would briefly expose all of them. The
        // tool_execution_start event selects the single active row.
        return [];
      },
      invalidate() {},
    };
  };

  const hiddenToolResult = (context: any, options: any, output: string): Component => {
    if (options.isPartial) setStatus(context, "running");
    else completeStatus(context, output);
    return block([]);
  };

  // Keep the active supported tool in its normal renderer. Only completed
  // tools (and tool calls that have not started yet) use clean-mode hiding.
  const hideCleanTool = (toolCallId: string, expanded: boolean): boolean =>
    renderMode === "clean" && !expanded && cleanRun.activeToolCallId !== toolCallId;

  pi.registerEntryRenderer<ToolSummaryData>("pretty-tui-tool-summary", (entry, { expanded }, theme) => ({
    render(width: number): string[] {
      if (renderMode !== "clean" || expanded) return [];
      const data = entry.data;
      const groups = data?.groups?.length
        ? data.groups
        : data?.lastToolCallId
          ? [{
              count: data.count ?? 0,
              failed: data.failed ?? 0,
              lastToolCallId: data.lastToolCallId,
            }]
          : (() => {
              const summaryCallId = legacySummaryLastToolCallIds.get(entry.id);
              return summaryCallId
                ? [{ count: data?.count ?? 0, failed: data?.failed ?? 0, lastToolCallId: summaryCallId }]
                : [];
            })();
      // The live tool components own the visual positions. Keep this durable
      // entry as a fallback only for groups whose tool components are absent
      // from the current branch (for example, after compaction).
      const missingGroups = groups.filter((group) => !knownToolCallIds.has(group.lastToolCallId));
      if (missingGroups.length === 0) return [];
      return block(missingGroups.map((group) => summaryRow(theme, group.count, group.failed))).render(width);
    },
    invalidate() {},
  }));

  pi.on("session_start", (_event, ctx) => {
    cleanToolsExpanded = ctx.ui.getToolsExpanded();
    settledSummaries.clear();
    legacySummaryLastToolCallIds.clear();
    cleanRun.count = 0;
    cleanRun.failed = 0;
    cleanRun.groups = [];
    cleanRun.activeToolCallId = undefined;
    cleanRun.lastCompletedToolCallId = undefined;
    cleanRun.active = false;
    cleanRun.settled = false;

    let count = 0;
    let failed = 0;
    let lastToolCallId: string | undefined;
    let lastFinishedGroup: ToolSummaryGroup | undefined;
    const toolCalls = new Set<string>();
    const explicitSummaryIds = new Set<string>();

    const rememberGroup = (group: ToolSummaryGroup, entryId?: string) => {
      settledSummaries.set(group.lastToolCallId, {
        count: group.count,
        failed: group.failed,
      });
      if (entryId) legacySummaryLastToolCallIds.set(entryId, group.lastToolCallId);
      explicitSummaryIds.add(group.lastToolCallId);
    };

    const finishGroup = () => {
      if (lastToolCallId && count > 0) {
        lastFinishedGroup = { count, failed, lastToolCallId };
        if (!explicitSummaryIds.has(lastToolCallId)) {
          settledSummaries.set(lastToolCallId, { count, failed });
        }
      }
      count = 0;
      failed = 0;
      lastToolCallId = undefined;
      toolCalls.clear();
    };

    // Use the same compaction-aware branch that Pi renders in the transcript;
    // getEntries() can also contain entries from other branches.
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      if (entry.type === "custom" && entry.customType === "pretty-tui-tool-summary") {
        const data = entry.data as ToolSummaryData | undefined;
        if (data?.groups?.length) {
          for (const group of data.groups) {
            if (group?.lastToolCallId && group.count > 0) rememberGroup(group);
          }
        } else if (data?.lastToolCallId) {
          rememberGroup({
            count: data.count ?? 0,
            failed: data.failed ?? 0,
            lastToolCallId: data.lastToolCallId,
          });
        } else if (lastFinishedGroup) {
          // Migrate summaries written by the earlier clean-mode versions,
          // which did not persist the final tool call id. The text message
          // preceding this entry has already closed the group.
          rememberGroup({
            count: data?.count ?? lastFinishedGroup.count,
            failed: data?.failed ?? lastFinishedGroup.failed,
            lastToolCallId: lastFinishedGroup.lastToolCallId,
          }, entry.id);
        } else if (lastToolCallId && count > 0) {
          // Also handle a legacy entry inserted before the boundary text.
          rememberGroup({
            count: data?.count ?? count,
            failed: data?.failed ?? failed,
            lastToolCallId,
          }, entry.id);
        }
        continue;
      }

      if (entry.type !== "message") continue;
      const message = entry.message as any;

      if (message.role === "user") {
        finishGroup();
        lastFinishedGroup = undefined;
        continue;
      }

      if (message.role === "assistant") {
        const hasVisibleText = (message.content ?? []).some(
          (item: any) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
        );
        if (hasVisibleText) finishGroup();
        for (const item of message.content ?? []) {
          if (item.type !== "toolCall" || !supportedTools.has(item.name)) continue;
          count++;
          lastToolCallId = item.id;
          toolCalls.add(item.id);
        }
        continue;
      }

      if (message.role === "toolResult" && toolCalls.has(message.toolCallId) && message.isError) {
        failed++;
      }
    }

    finishGroup();
  });

  const hasVisibleAssistantText = (message: any): boolean =>
    message?.role === "assistant" && (message.content ?? []).some(
      (item: any) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
    );

  // A visible assistant response is the boundary between tool groups. Do
  // this during streaming so a following tool call cannot inherit the prior
  // summary, while message_end keeps the rule correct for non-streaming paths.
  pi.on("message_update", (event) => {
    if (hasVisibleAssistantText(event.message)) finishCleanGroup();
  });
  pi.on("message_end", (event) => {
    if (hasVisibleAssistantText(event.message)) finishCleanGroup();
  });

  pi.on("agent_start", () => {
    // A retry can start another low-level agent loop. Keep the accumulated
    // count until the whole run reaches agent_settled.
    if (!cleanRun.active) {
      cleanRun.count = 0;
      cleanRun.failed = 0;
      cleanRun.groups = [];
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
    if (cleanRun.settled) return;

    // Finalize the last group after retries/compaction have definitely ended.
    finishCleanGroup();
    cleanRun.active = false;
    cleanRun.activeToolCallId = undefined;
    cleanRun.settled = true;

    const groups = cleanRun.groups.slice();
    if (renderMode !== "clean" || groups.length === 0) return;

    const count = groups.reduce((total, group) => total + group.count, 0);
    const failed = groups.reduce((total, group) => total + group.failed, 0);
    const lastToolCallId = groups[groups.length - 1]?.lastToolCallId;
    pi.appendEntry<ToolSummaryData>("pretty-tui-tool-summary", {
      count,
      failed,
      lastToolCallId,
      groups,
    });
  });

  const read = createReadTool(cwd);
  pi.registerTool({
    ...read,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "Read", context.toolCallId);
      const range = args.offset || args.limit
        ? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`
        : "";
      return call(theme, "Read", `${args.path}${range}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "Bash", context.toolCallId);
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
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "Edit", context.toolCallId);
      const count = Array.isArray(args.edits) ? ` · ${args.edits.length} changes` : "";
      return call(theme, "Edit", `${args.path}${count}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "Write", context.toolCallId);
      const content = typeof args.content === "string" ? args.content : "";
      return writeCall(theme, String(args.path ?? ""), content, context.expanded, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "Grep", context.toolCallId);
      const where = args.path ? ` · ${args.path}` : "";
      const glob = args.glob ? ` · ${args.glob}` : "";
      return call(theme, "Grep", `${args.pattern}${where}${glob}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "Find", context.toolCallId);
      return call(theme, "Find", `${args.pattern}${args.path ? ` · ${args.path}` : ""}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded)) return cleanToolCall(theme, "List", context.toolCallId);
      return call(theme, "List", args.path ?? ".", context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded)) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Listing…");
      const failed = completeStatus(context, output);
      const entries = nonEmptyLines(output);
      return result(theme, failed ? output.split("\n")[0] : `Listed ${entries} entries`, output, options.expanded, failed);
    },
  } as any);
}

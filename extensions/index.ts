import {
  AssistantMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  UserMessageComponent,
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
const CLEAN_TOOL_ACTIVITY_MIN_MS = 1000;
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

/** Polished user messages, tool calls, and list rendering for Pi's TUI. */
export default function prettyTui(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const configPath = join(getAgentDir(), "pretty-tui.json");
  let config = loadConfig(configPath);
  const configuredMode = config.mode ?? config.bash?.mode;
  let renderMode: PrettyTuiMode = configuredMode === "compact" || configuredMode === "clean"
    ? configuredMode
    : "full";
  let cleanToolsExpanded = false;
  let changingAllToolsExpansion = false;
  const cleanCompactToolCallIds = new Set<string>();
  const cleanGroupToolCallIds = new Map<string, string[]>();
  const cleanToolCallGroupOwners = new Map<string, string>();
  const cleanToolComponents = new Map<string, any>();
  const cleanToolThemes = new Map<string, any>();
  let renderCleanGroupSummary = (_lastToolCallId: string, _width: number): string[] => [];

  const setCleanGroupMembers = (lastToolCallId: string, toolCallIds: string[]) => {
    cleanGroupToolCallIds.set(lastToolCallId, toolCallIds);
    for (const toolCallId of toolCallIds) cleanToolCallGroupOwners.set(toolCallId, lastToolCallId);
  };

  const saveRenderMode = (mode: PrettyTuiMode) => {
    config = { ...config, mode };
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  pi.registerCommand("pretty-tui", {
    description: "Configure pi-pretty-tui rendering mode",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "full", label: "full", description: "Full tool details and output" },
        { value: "compact", label: "compact", description: "Concise summaries for all built-in tools" },
        { value: "clean", label: "clean", description: "Group supported tools into Running/Done status" },
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
        const full = `Full — full tool details and output${renderMode === "full" ? " (current)" : ""}`;
        const compact = `Compact — concise summaries for all built-in tools${renderMode === "compact" ? " (current)" : ""}`;
        const clean = `Clean — group supported tools into Running/Done status${renderMode === "clean" ? " (current)" : ""}`;
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

      cleanCompactToolCallIds.clear();
      renderMode = requested;
      for (const component of cleanToolComponents.values()) component.updateDisplay?.();
      try {
        saveRenderMode(renderMode);
        ctx.ui.notify(`pi-pretty-tui mode set to: ${renderMode}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Mode changed for this session, but could not save settings: ${message}`, "warning");
      }
    },
  });

  // Render user prompts as a titled, rounded frame while preserving Pi's
  // original Markdown component, wrapping, output padding, and OSC 133 zones.
  const userMessagePrototype = UserMessageComponent.prototype as any;
  const userMessagePatchKey = Symbol.for("pretty-tui.user-message-frame");
  if (!userMessagePrototype[userMessagePatchKey]) {
    const originalUserMessageRebuild = userMessagePrototype.rebuild;
    const patchedUserMessageRebuild = function (this: any) {
      originalUserMessageRebuild.call(this);
      const content = this.children?.[0] as any;
      if (!content) return;

      // Reuse Pi's theme-aware user background across the complete frame.
      const userMessageBg = content.bgFn as ((text: string) => string) | undefined;
      content.paddingX = 0;
      content.paddingY = 0;
      content.setBgFn?.(undefined);
      content.invalidate?.();

      const outputPad = Math.max(0, Number(this.outputPad) || 0);
      const markdownTheme = this.markdownTheme;
      const border = (text: string) => markdownTheme.quoteBorder(text);
      const frame: Component = {
        render(width: number): string[] {
          const sidePad = Math.min(outputPad, Math.max(0, Math.floor((width - 1) / 2)));
          const outer = " ".repeat(sidePad);
          const frameWidth = Math.max(1, width - sidePad * 2);
          const paintBackground = (line: string) => {
            const padding = " ".repeat(Math.max(0, frameWidth - visibleWidth(line)));
            return userMessageBg ? userMessageBg(line + padding) : line + padding;
          };
          if (frameWidth < 4) {
            return content.render(frameWidth).map((line: string) => outer + paintBackground(line));
          }

          const title = " User ";
          const topStart = "╭─";
          const topTail = "─".repeat(Math.max(0, frameWidth - visibleWidth(topStart) - visibleWidth(title) - 1));
          const top = border(topStart + markdownTheme.bold(title) + topTail + "╮");
          const bottom = border("╰" + "─".repeat(Math.max(0, frameWidth - 2)) + "╯");
          const contentWidth = Math.max(1, frameWidth - 4);
          const body = content.render(contentWidth).map((line: string) => {
            const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
            return border("│ ") + line + padding + border(" │");
          });
          return [top, ...body, bottom].map((line: string) => outer + paintBackground(line));
        },
        invalidate() {
          content.invalidate?.();
        },
      };

      this.clear();
      this.addChild(frame);
    };

    userMessagePrototype[userMessagePatchKey] = {
      originalRebuild: originalUserMessageRebuild,
      patchedRebuild: patchedUserMessageRebuild,
    };
    userMessagePrototype.rebuild = patchedUserMessageRebuild;

    pi.on("session_shutdown", () => {
      const patch = userMessagePrototype[userMessagePatchKey];
      if (!patch) return;
      if (patch.patchedRebuild === userMessagePrototype.rebuild) {
        userMessagePrototype.rebuild = patch.originalRebuild;
      }
      if (userMessagePrototype.rebuild === patch.originalRebuild) {
        delete userMessagePrototype[userMessagePatchKey];
      }
    });
  }

  // Pi's built-in assistant component turns hidden thinking into a static
  // "Thinking..." label. In collapsed clean mode, omit that label entirely;
  // the clean-mode Running(...) row owns activity, while Ctrl+O still reveals
  // the thinking content. The component is exported by Pi specifically for
  // extension-level rendering customizations, so patch its public methods
  // rather than Pi's source.
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
      // In collapsed clean mode, omit Pi's built-in Thinking... placeholder
      // entirely. The clean-mode Running(...) row owns the activity label;
      // expanded mode still reveals the actual thinking content.
      const displayMessage = showThinking
        ? message
        : { ...message, content: content.filter((item: any) => item.type !== "thinking") };
      const previousHideThinkingBlock = this.hideThinkingBlock;
      this.hideThinkingBlock = false;
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
      changingAllToolsExpansion = true;
      if (!expanded) cleanCompactToolCallIds.clear();
      try {
        return originalSetToolsExpanded.call(this, expanded);
      } finally {
        changingAllToolsExpansion = false;
      }
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
    toolCallIds?: string[];
    activity?: string;
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
  type ToolActivityHold = {
    toolCallId: string;
    name: string;
    until: number;
    after: string;
    started: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  const settledSummaries = new Map<string, { count: number; failed: number; activity: DisplayValue }>();
  const toolActivityHolds = new Map<string, ToolActivityHold>();
  const legacySummaryLastToolCallIds = new Map<string, string>();
  const knownToolCallIds = new Set<string>();
  type CleanRunState = {
    activeToolCallId?: string;
    lastCompletedToolCallId?: string;
    activeToolName?: string;
    activity?: string;
    requestRender?: () => void;
    count: number;
    failed: number;
    currentToolCallIds: string[];
    groups: ToolSummaryGroup[];
    active: boolean;
    settled: boolean;
  };
  const cleanRun: CleanRunState = {
    count: 0,
    failed: 0,
    currentToolCallIds: [],
    groups: [],
    active: false,
    settled: false,
  };

  const toolDisplayName = (name: string): string =>
    name === "ls" ? "List" : name.charAt(0).toUpperCase() + name.slice(1);

  const clearToolActivityHolds = () => {
    for (const hold of toolActivityHolds.values()) {
      if (hold.timer) clearTimeout(hold.timer);
    }
    toolActivityHolds.clear();
  };

  const heldActivity = (hold: ToolActivityHold): string =>
    Date.now() < hold.until ? hold.name : hold.after;

  const scheduleToolActivityRelease = (hold: ToolActivityHold) => {
    if (hold.timer) clearTimeout(hold.timer);
    const delay = Math.max(0, hold.until - Date.now());
    hold.timer = setTimeout(() => {
      hold.timer = undefined;
      if (Date.now() < hold.until) {
        scheduleToolActivityRelease(hold);
        return;
      }
      if (toolActivityHolds.get(hold.toolCallId) === hold) {
        toolActivityHolds.delete(hold.toolCallId);
      }
      if (cleanRun.lastCompletedToolCallId === hold.toolCallId && !cleanRun.activeToolCallId) {
        cleanRun.activeToolName = undefined;
        cleanRun.activity = hold.after;
      }
      cleanRun.requestRender?.();
    }, delay);
  };

  const beginToolActivity = (toolCallId: string, name: string, started = false) => {
    const previous = toolActivityHolds.get(toolCallId);
    if (previous) {
      if (previous.timer) clearTimeout(previous.timer);
      previous.name = name;
      previous.started ||= started;
      cleanRun.activeToolName = name;
      cleanRun.activity = name;
      return;
    }
    const startedAt = Date.now();
    toolActivityHolds.set(toolCallId, {
      toolCallId,
      name,
      until: startedAt + CLEAN_TOOL_ACTIVITY_MIN_MS,
      after: "thinking...",
      started,
    });
    cleanRun.activeToolName = name;
    cleanRun.activity = name;
  };

  const holdToolActivity = (toolCallId: string, name: string) => {
    let hold = toolActivityHolds.get(toolCallId);
    if (!hold) {
      const now = Date.now();
      hold = {
        toolCallId,
        name,
        until: now + CLEAN_TOOL_ACTIVITY_MIN_MS,
        after: "thinking...",
        started: true,
      };
      toolActivityHolds.set(toolCallId, hold);
    }
    hold.name = name;
    hold.started = true;
    hold.after = "thinking...";
    scheduleToolActivityRelease(hold);
  };

  const activityValueForHold = (toolCallId: string, after: string): DisplayValue => {
    const hold = toolActivityHolds.get(toolCallId);
    if (!hold) return after;
    hold.after = after;
    return () => heldActivity(hold);
  };

  const currentCleanActivity = (): string => {
    if (cleanRun.activeToolCallId) {
      return cleanRun.activeToolName ?? cleanRun.activity ?? "thinking...";
    }
    if (cleanRun.lastCompletedToolCallId) {
      const hold = toolActivityHolds.get(cleanRun.lastCompletedToolCallId);
      if (hold) return heldActivity(hold);
    }
    return cleanRun.activeToolName ?? cleanRun.activity ?? (cleanRun.active ? "thinking..." : "done");
  };

  pi.on("session_shutdown", clearToolActivityHolds);

  // A tool component can be created from the streamed assistant message
  // before Pi dispatches tool_execution_start. Mark its activity at the
  // component's own execution boundary too, so the first clean render names it.
  const toolExecutionPrototype = ToolExecutionComponent.prototype as any;
  const toolExecutionPatchKey = Symbol.for("pretty-tui.clean-tool-execution");
  if (!toolExecutionPrototype[toolExecutionPatchKey]) {
    const originalMarkExecutionStarted = toolExecutionPrototype.markExecutionStarted;
    const originalSetExpanded = toolExecutionPrototype.setExpanded;
    const originalToolRender = toolExecutionPrototype.render;
    const originalToolHandleMouse = toolExecutionPrototype.handleMouse;
    const renderedModeKey = Symbol("pretty-tui.tool-rendered-mode");
    const revealCleanGroup = (groupToolCallIds: string[], ui?: any) => {
      for (const toolCallId of groupToolCallIds) cleanCompactToolCallIds.add(toolCallId);
      for (const toolCallId of groupToolCallIds) cleanToolComponents.get(toolCallId)?.updateDisplay();
      ui?.requestRender?.();
    };
    const patchedMarkExecutionStarted = function (this: any) {
      if (supportedTools.has(this.toolName)) {
        if (typeof this.ui?.requestRender === "function") {
          cleanRun.requestRender = () => this.ui.requestRender();
        }
        cleanRun.active = true;
        cleanRun.activeToolCallId = this.toolCallId;
        beginToolActivity(this.toolCallId, toolDisplayName(this.toolName), true);
      }
      return originalMarkExecutionStarted.call(this);
    };
    const patchedSetExpanded = function (this: any, expanded: boolean) {
      const groupToolCallIds = cleanGroupToolCallIds.get(this.toolCallId);
      if (
        renderMode === "clean" &&
        !changingAllToolsExpansion &&
        expanded &&
        !this.expanded &&
        !cleanCompactToolCallIds.has(this.toolCallId) &&
        groupToolCallIds?.length
      ) {
        revealCleanGroup(groupToolCallIds, this.ui);
        return;
      }
      return originalSetExpanded.call(this, expanded);
    };
    const patchedToolRender = function (this: any, width: number): string[] {
      if (supportedTools.has(this.toolName)) cleanToolComponents.set(this.toolCallId, this);
      if (this[renderedModeKey] !== renderMode) {
        this[renderedModeKey] = renderMode;
        this.updateDisplay();
      }

      const groupOwner = cleanToolCallGroupOwners.get(this.toolCallId);
      const groupToolCallIds = groupOwner ? cleanGroupToolCallIds.get(groupOwner) : undefined;
      const childIndex = groupToolCallIds?.indexOf(this.toolCallId) ?? -1;
      const showAsChild = renderMode === "clean" && childIndex >= 0 && cleanCompactToolCallIds.has(this.toolCallId);
      if (!showAsChild || !groupOwner || !groupToolCallIds) {
        return originalToolRender.call(this, width);
      }

      const rawChildPrefix = childIndex === groupToolCallIds.length - 1 ? "  └─ " : "  ├─ ";
      const rawContinuation = childIndex === groupToolCallIds.length - 1 ? "     " : "  │  ";
      const childTheme = cleanToolThemes.get(this.toolCallId);
      const childPrefix = childTheme ? childTheme.fg("dim", rawChildPrefix) : rawChildPrefix;
      const continuation = childTheme ? childTheme.fg("dim", rawContinuation) : rawContinuation;
      const childWidth = Math.max(1, width - visibleWidth(rawChildPrefix));
      const lines = originalToolRender.call(this, childWidth);
      if (lines.length === 0) return lines;

      const decoratedContent = lines.slice(1).map((line: string, index: number) =>
        (index === 0 ? childPrefix : continuation) + line
      );
      if (childIndex !== 0) return decoratedContent;
      return [lines[0], ...renderCleanGroupSummary(groupOwner, width), ...decoratedContent];
    };
    const patchedToolHandleMouse = function (this: any, event: any) {
      const groupOwner = cleanToolCallGroupOwners.get(this.toolCallId);
      const groupToolCallIds = groupOwner ? cleanGroupToolCallIds.get(groupOwner) : undefined;
      const childIndex = groupToolCallIds?.indexOf(this.toolCallId) ?? -1;
      const showAsChild = renderMode === "clean" && childIndex >= 0 && cleanCompactToolCallIds.has(this.toolCallId);
      const isLeftClick = event.type === "click" && event.button === "left";

      // Pi normally ignores tool clicks until a result exists. Clean mode can
      // still reveal the active call safely because this changes presentation
      // only; it does not affect or delay execution.
      if (
        renderMode === "clean" &&
        !showAsChild &&
        isLeftClick &&
        this.toolCallId === groupOwner &&
        groupToolCallIds?.length
      ) {
        revealCleanGroup(groupToolCallIds, this.ui);
        return { handled: true };
      }
      if (!showAsChild || !groupToolCallIds) return originalToolHandleMouse.call(this, event);

      const summaryHeight = childIndex === 0 ? renderCleanGroupSummary(groupOwner!, event.width).length : 0;
      if (
        childIndex === 0 &&
        event.y > 0 &&
        event.y <= summaryHeight &&
        isLeftClick
      ) {
        changingAllToolsExpansion = true;
        try {
          for (const toolCallId of groupToolCallIds) {
            const component = cleanToolComponents.get(toolCallId);
            if (component?.expanded) originalSetExpanded.call(component, false);
            cleanCompactToolCallIds.delete(toolCallId);
          }
          for (const toolCallId of groupToolCallIds) cleanToolComponents.get(toolCallId)?.updateDisplay();
        } finally {
          changingAllToolsExpansion = false;
        }
        this.ui?.requestRender?.();
        return { handled: true };
      }

      if (!this.result && isLeftClick) {
        originalSetExpanded.call(this, !this.expanded);
        this.ui?.requestRender?.();
        return { handled: true };
      }

      const childPrefixWidth = visibleWidth("  ├─ ");
      return originalToolHandleMouse.call(this, {
        ...event,
        x: Math.max(0, event.x - childPrefixWidth),
        y: event.y - summaryHeight + (childIndex === 0 ? 0 : 1),
        width: Math.max(1, event.width - childPrefixWidth),
      });
    };

    toolExecutionPrototype[toolExecutionPatchKey] = {
      originalMarkExecutionStarted,
      patchedMarkExecutionStarted,
      originalSetExpanded,
      patchedSetExpanded,
      originalRender: originalToolRender,
      patchedRender: patchedToolRender,
      originalHandleMouse: originalToolHandleMouse,
      patchedHandleMouse: patchedToolHandleMouse,
    };
    toolExecutionPrototype.markExecutionStarted = patchedMarkExecutionStarted;
    toolExecutionPrototype.setExpanded = patchedSetExpanded;
    toolExecutionPrototype.render = patchedToolRender;
    toolExecutionPrototype.handleMouse = patchedToolHandleMouse;

    pi.on("session_shutdown", () => {
      const patch = toolExecutionPrototype[toolExecutionPatchKey];
      if (!patch) return;
      if (patch.patchedMarkExecutionStarted === toolExecutionPrototype.markExecutionStarted) {
        toolExecutionPrototype.markExecutionStarted = patch.originalMarkExecutionStarted;
      }
      if (patch.patchedSetExpanded === toolExecutionPrototype.setExpanded) {
        toolExecutionPrototype.setExpanded = patch.originalSetExpanded;
      }
      if (patch.patchedRender === toolExecutionPrototype.render) {
        toolExecutionPrototype.render = patch.originalRender;
      }
      if (patch.patchedHandleMouse === toolExecutionPrototype.handleMouse) {
        toolExecutionPrototype.handleMouse = patch.originalHandleMouse;
      }
      if (
        toolExecutionPrototype.markExecutionStarted === patch.originalMarkExecutionStarted &&
        toolExecutionPrototype.setExpanded === patch.originalSetExpanded &&
        toolExecutionPrototype.render === patch.originalRender &&
        toolExecutionPrototype.handleMouse === patch.originalHandleMouse
      ) {
        delete toolExecutionPrototype[toolExecutionPatchKey];
      }
    });
  }

  const finishCleanGroup = (activity = cleanRun.activity ?? "done") => {
    if (cleanRun.lastCompletedToolCallId && cleanRun.count > 0) {
      const group: ToolSummaryGroup = {
        count: cleanRun.count,
        failed: cleanRun.failed,
        lastToolCallId: cleanRun.lastCompletedToolCallId,
        toolCallIds: cleanRun.currentToolCallIds.slice(),
        activity,
      };
      cleanRun.groups.push(group);
      settledSummaries.set(group.lastToolCallId, {
        count: group.count,
        failed: group.failed,
        activity: activityValueForHold(group.lastToolCallId, activity),
      });
      setCleanGroupMembers(group.lastToolCallId, group.toolCallIds ?? []);
    }
    cleanRun.count = 0;
    cleanRun.failed = 0;
    cleanRun.currentToolCallIds = [];
    cleanRun.lastCompletedToolCallId = undefined;
    cleanRun.activeToolCallId = undefined;
    cleanRun.activeToolName = undefined;
  };

  const settleLastCleanGroup = () => {
    const group = cleanRun.groups[cleanRun.groups.length - 1];
    if (!group) return;
    group.activity = "done";
    settledSummaries.set(group.lastToolCallId, {
      count: group.count,
      failed: group.failed,
      activity: activityValueForHold(group.lastToolCallId, "done"),
    });
  };

  const summaryText = (count: number, _failed: number, activity = "done"): string => {
    const activityText = typeof activity === "string" ? activity : "done";
    const countLabel = `${count} tool ${count === 1 ? "call" : "calls"}`;
    const activityLabel = activityText !== "done" && activityText.trim()
      ? ` · ${activityText}`
      : "";
    return `${countLabel}${activityLabel}`;
  };

  const summaryRow = (
    theme: any,
    count: number,
    failed: number,
    activity: DisplayValue = "done",
  ): DisplayRow => ({
    prefix: () => {
      const currentActivity = typeof activity === "function" ? activity() : activity;
      const color = currentActivity === "done" ? "success" : "accent";
      return theme.fg(color, "● ");
    },
    continuation: "  ",
    content: () => {
      const currentActivity = typeof activity === "function" ? activity() : activity;
      const label = currentActivity === "done" ? "Done" : "Running";
      const color = label === "Done" ? "success" : "accent";
      return theme.fg(color, theme.bold(label)) +
        theme.fg("dim", "(") +
        theme.fg("text", summaryText(count, failed, currentActivity)) + theme.fg("dim", ")");
    },
  });

  renderCleanGroupSummary = (lastToolCallId: string, width: number): string[] => {
    const summaryTheme = cleanToolThemes.get(lastToolCallId);
    if (!summaryTheme) return [];
    const settled = settledSummaries.get(lastToolCallId);
    if (settled) {
      return block([summaryRow(summaryTheme, settled.count, settled.failed, settled.activity)]).render(width);
    }
    if (cleanRun.activeToolCallId === lastToolCallId) {
      return block([summaryRow(
        summaryTheme,
        cleanRun.count + 1,
        cleanRun.failed,
        () => cleanRun.activeToolName ?? currentCleanActivity(),
      )]).render(width);
    }
    if (cleanRun.lastCompletedToolCallId === lastToolCallId && cleanRun.count > 0) {
      return block([summaryRow(summaryTheme, cleanRun.count, cleanRun.failed, currentCleanActivity)]).render(width);
    }
    return [];
  };

  /**
   * Clean mode keeps Running/Done rows in the existing tool components. This
   * avoids waiting for agent_end (which can be followed by retry/compaction),
   * leaves a visible count between calls, and keeps each row in transcript order.
   */
  const cleanToolCall = (theme: any, name: string, toolCallId: string): Component => {
    knownToolCallIds.add(toolCallId);
    cleanToolThemes.set(toolCallId, theme);
    return {
      render(width: number): string[] {
        if (renderMode !== "clean") return [];

        const settledSummary = settledSummaries.get(toolCallId);
        if (settledSummary) {
          return block([summaryRow(theme, settledSummary.count, settledSummary.failed, settledSummary.activity)]).render(width);
        }
        if (cleanRun.settled) return [];

        if (cleanRun.activeToolCallId === toolCallId) {
          return block([summaryRow(
            theme,
            cleanRun.count + 1,
            cleanRun.failed,
            () => cleanRun.activeToolName ?? name,
          )]).render(width);
        }

        // The active tool owns the live Running row. Keep the latest completed
        // portion hidden while that tool's minimum display time is running.
        if (
          cleanRun.lastCompletedToolCallId === toolCallId &&
          cleanRun.count > 0 &&
          !cleanRun.activeToolCallId
        ) {
          return block([summaryRow(theme, cleanRun.count, cleanRun.failed, currentCleanActivity)]).render(width);
        }

        // Do not fall back to the per-component pending state here: Pi may
        // create several tool-call components before execution starts, and
        // showing that fallback would briefly expose all of them. The active
        // component is selected to render the current Running row at execution start.
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

  // In collapsed clean mode, every supported tool call is represented by its
  // Running row. Ctrl+O bypasses this and restores the normal full renderer.
  const hideCleanTool = (
    toolCallId: string,
    expanded: boolean,
    _executionStarted = false,
  ): boolean => renderMode === "clean" && !expanded && !cleanCompactToolCallIds.has(toolCallId);

  const useCompactToolView = (toolCallId: string, expanded: boolean): boolean =>
    !expanded && (
      renderMode === "compact" ||
      (renderMode === "clean" && cleanCompactToolCallIds.has(toolCallId))
    );

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
                ? [{
                    count: data?.count ?? 0,
                    failed: data?.failed ?? 0,
                    lastToolCallId: summaryCallId,
                  }]
                : [];
            })();
      // The live tool components own the visual positions. Keep this durable
      // entry as a fallback only for groups whose tool components are absent
      // from the current branch (for example, after compaction).
      const missingGroups = groups.filter((group) => !knownToolCallIds.has(group.lastToolCallId));
      if (missingGroups.length === 0) return [];
      // Persisted entries represent settled groups. Older versions could
      // accidentally store the transient responding... activity, so always
      // normalize their display to Done.
      return block(missingGroups.map((group) =>
        summaryRow(theme, group.count, group.failed, "done")
      )).render(width);
    },
    invalidate() {},
  }));

  pi.on("session_start", (_event, ctx) => {
    cleanToolsExpanded = ctx.ui.getToolsExpanded();
    settledSummaries.clear();
    legacySummaryLastToolCallIds.clear();
    cleanCompactToolCallIds.clear();
    cleanGroupToolCallIds.clear();
    cleanToolCallGroupOwners.clear();
    cleanToolComponents.clear();
    cleanToolThemes.clear();
    clearToolActivityHolds();
    cleanRun.requestRender = undefined;
    cleanRun.count = 0;
    cleanRun.failed = 0;
    cleanRun.currentToolCallIds = [];
    cleanRun.groups = [];
    cleanRun.activeToolCallId = undefined;
    cleanRun.activeToolName = undefined;
    cleanRun.lastCompletedToolCallId = undefined;
    cleanRun.activity = undefined;
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
        activity: "done",
      });
      if (group.toolCallIds?.length) {
        setCleanGroupMembers(group.lastToolCallId, group.toolCallIds.slice());
      }
      if (entryId) legacySummaryLastToolCallIds.set(entryId, group.lastToolCallId);
      explicitSummaryIds.add(group.lastToolCallId);
    };

    const finishGroup = () => {
      if (lastToolCallId && count > 0) {
        lastFinishedGroup = { count, failed, lastToolCallId, toolCallIds: [...toolCalls] };
        setCleanGroupMembers(lastToolCallId, [...toolCalls]);
        if (!explicitSummaryIds.has(lastToolCallId)) {
          settledSummaries.set(lastToolCallId, { count, failed, activity: "done" });
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

  const latestPendingToolCall = (message: any): any =>
    [...(message?.content ?? [])].reverse().find(
      (item: any) => item.type === "toolCall" && supportedTools.has(item.name) && item.id,
    );

  const trackPendingToolActivity = (message: any): boolean => {
    const toolCall = latestPendingToolCall(message);
    if (!toolCall || cleanRun.lastCompletedToolCallId === toolCall.id) return false;
    if (!cleanRun.currentToolCallIds.includes(toolCall.id)) {
      cleanRun.currentToolCallIds.push(toolCall.id);
    }
    setCleanGroupMembers(toolCall.id, cleanRun.currentToolCallIds.slice());
    cleanRun.active = true;
    cleanRun.activeToolCallId = toolCall.id;
    beginToolActivity(toolCall.id, toolDisplayName(toolCall.name));
    return true;
  };

  const clearPendingToolActivities = () => {
    for (const [toolCallId, hold] of toolActivityHolds) {
      if (hold.started) continue;
      if (hold.timer) clearTimeout(hold.timer);
      toolActivityHolds.delete(toolCallId);
      if (cleanRun.activeToolCallId === toolCallId) {
        cleanRun.activeToolCallId = undefined;
        cleanRun.activeToolName = undefined;
      }
    }
  };

  // A visible assistant response is the boundary between tool groups. Do
  // this during streaming so a following tool call cannot inherit the prior
  // summary, while message_end keeps the rule correct for non-streaming paths.
  pi.on("message_update", (event) => {
    if (hasVisibleAssistantText(event.message)) {
      cleanRun.activity = "responding...";
      finishCleanGroup("responding...");
      return;
    }
    trackPendingToolActivity(event.message);
  });
  pi.on("message_end", (event) => {
    if (hasVisibleAssistantText(event.message)) {
      cleanRun.activity = "done";
      finishCleanGroup("done");
      settleLastCleanGroup();
      return;
    }
    trackPendingToolActivity(event.message);
  });

  pi.on("agent_start", () => {
    // A retry can start another low-level agent loop. Keep the accumulated
    // count until the whole run reaches agent_settled.
    if (!cleanRun.active) {
      clearToolActivityHolds();
      cleanRun.count = 0;
      cleanRun.failed = 0;
      cleanRun.currentToolCallIds = [];
      cleanRun.groups = [];
      cleanRun.lastCompletedToolCallId = undefined;
      cleanRun.settled = false;
    }
    cleanRun.active = true;
    cleanRun.activeToolCallId = undefined;
    cleanRun.activeToolName = undefined;
    cleanRun.activity = "thinking...";
  });
  pi.on("tool_execution_start", (event) => {
    if (!supportedTools.has(event.toolName)) return;
    if (!cleanRun.currentToolCallIds.includes(event.toolCallId)) {
      cleanRun.currentToolCallIds.push(event.toolCallId);
    }
    setCleanGroupMembers(event.toolCallId, cleanRun.currentToolCallIds.slice());
    cleanRun.active = true;
    cleanRun.activeToolCallId = event.toolCallId;
    beginToolActivity(event.toolCallId, toolDisplayName(event.toolName), true);
  });
  pi.on("tool_execution_end", (event) => {
    if (!supportedTools.has(event.toolName)) return;
    const activityName = cleanRun.activeToolCallId === event.toolCallId
      ? cleanRun.activeToolName ?? toolDisplayName(event.toolName)
      : toolDisplayName(event.toolName);
    // Keep the tool activity visible until at least one second after start;
    // this only delays the status transition, never the tool result itself.
    holdToolActivity(event.toolCallId, activityName);
    cleanRun.count++;
    if (event.isError) cleanRun.failed++;
    cleanRun.lastCompletedToolCallId = event.toolCallId;
    if (cleanRun.activeToolCallId === event.toolCallId) {
      cleanRun.activeToolCallId = undefined;
      cleanRun.activeToolName = undefined;
      cleanRun.activity = "thinking...";
    }
    const visibleSummaryToolCallId = cleanRun.activeToolCallId ?? cleanRun.lastCompletedToolCallId;
    setCleanGroupMembers(visibleSummaryToolCallId, cleanRun.currentToolCallIds.slice());
  });
  pi.on("agent_end", () => {
    // No summary is appended here: this event may be followed by an automatic
    // retry or compaction. The live row remains available until settled.
    clearPendingToolActivities();
    cleanRun.activeToolCallId = undefined;
    cleanRun.activeToolName = undefined;
    cleanRun.activity = "thinking...";
  });
  pi.on("agent_settled", () => {
    if (cleanRun.settled) return;

    clearPendingToolActivities();
    // Finalize the last group after retries/compaction have definitely ended.
    finishCleanGroup("done");
    for (const group of cleanRun.groups) {
      group.activity = "done";
      settledSummaries.set(group.lastToolCallId, {
        count: group.count,
        failed: group.failed,
        activity: activityValueForHold(group.lastToolCallId, "done"),
      });
    }
    cleanRun.active = false;
    cleanRun.activeToolCallId = undefined;
    cleanRun.activeToolName = undefined;
    cleanRun.activity = "done";
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
      groups: groups.map(({ count, failed, lastToolCallId, toolCallIds }) => ({
        count,
        failed,
        lastToolCallId,
        toolCallIds,
      })),
    });
  });

  const read = createReadTool(cwd);
  pi.registerTool({
    ...read,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "Read", context.toolCallId);
      const range = args.offset || args.limit
        ? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`
        : "";
      return call(theme, "Read", `${args.path}${range}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "Bash", context.toolCallId);
      const command = typeof args.command === "string" ? args.command : "";
      if (useCompactToolView(context.toolCallId, context.expanded)) {
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
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
      if (useCompactToolView(context.toolCallId, options.expanded)) {
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
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "Edit", context.toolCallId);
      const count = Array.isArray(args.edits) ? ` · ${args.edits.length} changes` : "";
      return call(theme, "Edit", `${args.path}${count}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "Write", context.toolCallId);
      const content = typeof args.content === "string" ? args.content : "";
      const path = String(args.path ?? "");
      if (useCompactToolView(context.toolCallId, context.expanded)) {
        const lines = content.replace(/\t/g, "    ").split("\n");
        while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const total = lines.length;
        return call(theme, "Write", `${path} · ${total} ${total === 1 ? "line" : "lines"}`, context.state);
      }
      return writeCall(theme, path, content, context.expanded, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "Grep", context.toolCallId);
      const where = args.path ? ` · ${args.path}` : "";
      const glob = args.glob ? ` · ${args.glob}` : "";
      return call(theme, "Grep", `${args.pattern}${where}${glob}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "Find", context.toolCallId);
      return call(theme, "Find", `${args.pattern}${args.path ? ` · ${args.path}` : ""}`, context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
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
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, "List", context.toolCallId);
      return call(theme, "List", args.path ?? ".", context.state);
    },
    renderResult(toolResult: any, options: any, theme: any, context: any) {
      const output = textContent(toolResult);
      if (hideCleanTool(context.toolCallId, options.expanded, context.executionStarted)) return hiddenToolResult(context, options, output);
      if (options.isPartial) return partialResult(context, theme, "Listing…");
      const failed = completeStatus(context, output);
      const entries = nonEmptyLines(output);
      return result(theme, failed ? output.split("\n")[0] : `Listed ${entries} entries`, output, options.expanded, failed);
    },
  } as any);
}

import {
  AssistantMessageComponent,
  CustomEditor,
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
  copyToClipboard,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  truncateToWidth,
  type TuiMouseEvent,
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
  let renderMode: PrettyTuiMode = configuredMode === "full" || configuredMode === "compact" || configuredMode === "clean"
    ? configuredMode
    : "clean";
  let cleanToolsExpanded = false;
  let cleanContextCompacted = false;
  let fullscreenTui = false;
  let currentTui: any;
  let currentExtensionUi: any;
  let changingAllToolsExpansion = false;
  const cleanCompactToolCallIds = new Set<string>();
  const cleanGroupToolCallIds = new Map<string, string[]>();
  const cleanToolCallGroupOwners = new Map<string, string>();
  const cleanToolComponents = new Map<string, any>();
  const cleanToolThemes = new Map<string, any>();
  const cleanToolNames = new Map<string, string>();
  let renderCleanGroupSummary = (_lastToolCallId: string, _width: number): string[] => [];

  const setCleanGroupMembers = (lastToolCallId: string, toolCallIds: string[]) => {
    cleanGroupToolCallIds.set(lastToolCallId, toolCallIds);
    for (const toolCallId of toolCallIds) cleanToolCallGroupOwners.set(toolCallId, lastToolCallId);
  };

  const isCleanGroupRevealed = (toolCallId: string): boolean => {
    if (cleanCompactToolCallIds.has(toolCallId)) return true;
    const groupOwner = cleanToolCallGroupOwners.get(toolCallId);
    const groupToolCallIds = groupOwner ? cleanGroupToolCallIds.get(groupOwner) : undefined;
    return groupToolCallIds?.some((id) => cleanCompactToolCallIds.has(id)) ?? false;
  };

  const cleanThemeForToolCall = (toolCallId: string): any => {
    const directTheme = cleanToolThemes.get(toolCallId);
    if (directTheme) return directTheme;
    const groupOwner = cleanToolCallGroupOwners.get(toolCallId);
    const groupToolCallIds = groupOwner ? cleanGroupToolCallIds.get(groupOwner) : undefined;
    return groupToolCallIds
      ?.map((id) => cleanToolThemes.get(id))
      .find(Boolean);
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

  // Give Pi's main prompt editor a complete rounded frame. Render the native
  // editor at a two-column narrower width so cursor layout, wrapping, IME, and
  // autocomplete remain native, then add one themed border column per side.
  const customEditorPrototype = CustomEditor.prototype as any;
  const editorFramePatchKey = Symbol.for("pretty-tui.rounded-editor-frame");
  if (!customEditorPrototype[editorFramePatchKey]) {
    const hadOwnRender = Object.prototype.hasOwnProperty.call(customEditorPrototype, "render");
    const hadOwnHandleMouse = Object.prototype.hasOwnProperty.call(customEditorPrototype, "handleMouse");
    const originalEditorRender = customEditorPrototype.render;
    const originalEditorHandleMouse = customEditorPrototype.handleMouse;
    const patchedEditorRender = function (this: any, width: number): string[] {
      if (width < 3) return originalEditorRender.call(this, width);

      const innerWidth = width - 2;
      const lines = originalEditorRender.call(this, innerWidth) as string[];
      const visibleLineCount = Math.max(0, Number(this.renderedVisibleLineCount) || 0);
      const bottomBorderIndex = visibleLineCount + 1;
      const fitInnerWidth = (line: string) =>
        line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));

      return lines.map((line, index) => {
        const fitted = fitInnerWidth(line);
        if (index === 0) return this.borderColor("╭") + fitted + this.borderColor("╮");
        if (index === bottomBorderIndex) return this.borderColor("╰") + fitted + this.borderColor("╯");
        if (index < bottomBorderIndex) return this.borderColor("│") + fitted + this.borderColor("│");
        // Autocomplete remains outside the input frame, aligned to its content.
        return " " + fitted + " ";
      });
    };
    const patchedEditorHandleMouse = function (this: any, event: any) {
      if (event.width < 3) return originalEditorHandleMouse.call(this, event);
      const innerWidth = event.width - 2;
      return originalEditorHandleMouse.call(this, {
        ...event,
        x: Math.max(0, Math.min(innerWidth - 1, event.x - 1)),
        width: innerWidth,
      });
    };

    customEditorPrototype[editorFramePatchKey] = {
      hadOwnRender,
      hadOwnHandleMouse,
      originalRender: originalEditorRender,
      originalHandleMouse: originalEditorHandleMouse,
      patchedRender: patchedEditorRender,
      patchedHandleMouse: patchedEditorHandleMouse,
    };
    customEditorPrototype.render = patchedEditorRender;
    customEditorPrototype.handleMouse = patchedEditorHandleMouse;

    pi.on("session_shutdown", () => {
      const patch = customEditorPrototype[editorFramePatchKey];
      if (!patch) return;
      if (patch.patchedRender === customEditorPrototype.render) {
        if (patch.hadOwnRender) customEditorPrototype.render = patch.originalRender;
        else delete customEditorPrototype.render;
      }
      if (patch.patchedHandleMouse === customEditorPrototype.handleMouse) {
        if (patch.hadOwnHandleMouse) customEditorPrototype.handleMouse = patch.originalHandleMouse;
        else delete customEditorPrototype.handleMouse;
      }
      if (
        customEditorPrototype.render === patch.originalRender &&
        customEditorPrototype.handleMouse === patch.originalHandleMouse
      ) {
        delete customEditorPrototype[editorFramePatchKey];
      }
    });
  }

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
  const orderContextEntriesForTranscript = (entries: any[]): any[] => {
    if (!Array.isArray(entries) || entries[0]?.type !== "compaction") return entries;
    const [compaction, ...contextEntries] = entries;
    const parentIndex = contextEntries.findIndex((entry: any) => entry?.id === compaction.parentId);
    const compactionTime = Date.parse(compaction.timestamp ?? "");
    const firstNewerIndex = Number.isFinite(compactionTime)
      ? contextEntries.findIndex((entry: any) => {
          const entryTime = Date.parse(entry?.timestamp ?? "");
          return Number.isFinite(entryTime) && entryTime >= compactionTime;
        })
      : -1;
    const insertionIndex = parentIndex >= 0
      ? parentIndex + 1
      : firstNewerIndex >= 0
        ? firstNewerIndex
        : contextEntries.length;
    return [
      ...contextEntries.slice(0, insertionIndex),
      compaction,
      ...contextEntries.slice(insertionIndex),
    ];
  };

  const interactiveModePrototype = InteractiveMode.prototype as any;
  const toolsExpansionPatchKey = Symbol.for("pretty-tui.clean-tool-expansion");
  if (!interactiveModePrototype[toolsExpansionPatchKey]) {
    const originalSetToolsExpanded = interactiveModePrototype.setToolsExpanded;
    const originalRenderSessionEntries = interactiveModePrototype.renderSessionEntries;
    const originalSwitchTuiMode = interactiveModePrototype.switchTuiMode;
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

    const patchedRenderSessionEntries = function (this: any, entries: any[], options?: any) {
      currentTui = this.ui;
      fullscreenTui = currentTui?.mode === "fullscreen";
      // buildContextEntries() prepends the latest compaction for model context,
      // while Pi's live compaction UI appends it chronologically. Keep reloads
      // and transcript rebuilds consistent with that live presentation.
      return originalRenderSessionEntries.call(
        this,
        orderContextEntriesForTranscript(entries),
        options,
      );
    };

    const patchedSwitchTuiMode = function (this: any, ...args: any[]) {
      const result = originalSwitchTuiMode.apply(this, args);
      currentTui = this.ui;
      fullscreenTui = currentTui?.mode === "fullscreen";
      return result;
    };

    interactiveModePrototype[toolsExpansionPatchKey] = {
      originalSetToolsExpanded,
      patchedSetToolsExpanded,
      originalRenderSessionEntries,
      patchedRenderSessionEntries,
      originalSwitchTuiMode,
      patchedSwitchTuiMode,
    };
    interactiveModePrototype.setToolsExpanded = patchedSetToolsExpanded;
    interactiveModePrototype.renderSessionEntries = patchedRenderSessionEntries;
    interactiveModePrototype.switchTuiMode = patchedSwitchTuiMode;

    pi.on("session_shutdown", () => {
      fullscreenTui = false;
      currentTui = undefined;
      currentExtensionUi = undefined;
      const patch = interactiveModePrototype[toolsExpansionPatchKey];
      if (!patch) return;
      if (patch.patchedSetToolsExpanded === interactiveModePrototype.setToolsExpanded) {
        interactiveModePrototype.setToolsExpanded = patch.originalSetToolsExpanded;
      }
      if (patch.patchedRenderSessionEntries === interactiveModePrototype.renderSessionEntries) {
        interactiveModePrototype.renderSessionEntries = patch.originalRenderSessionEntries;
      }
      if (patch.patchedSwitchTuiMode === interactiveModePrototype.switchTuiMode) {
        interactiveModePrototype.switchTuiMode = patch.originalSwitchTuiMode;
      }
      if (
        interactiveModePrototype.setToolsExpanded === patch.originalSetToolsExpanded &&
        interactiveModePrototype.renderSessionEntries === patch.originalRenderSessionEntries &&
        interactiveModePrototype.switchTuiMode === patch.originalSwitchTuiMode
      ) {
        delete interactiveModePrototype[toolsExpansionPatchKey];
      }
    });
  }

  // Refine Pi's Markdown presentation while preserving its parser and themes.
  const markdownPrototype = Markdown.prototype as any;
  const codeBlockPatchKey = Symbol.for("pretty-tui.code-blocks");
  const codeBlockCollectionKey = Symbol("pretty-tui.code-block-collection");
  const codeBlockRegionsKey = Symbol("pretty-tui.code-block-regions");
  if (!markdownPrototype[codeBlockPatchKey]) {
    const originalInvalidate = markdownPrototype.invalidate;
    const originalRender = markdownPrototype.render;
    const originalRenderToken = markdownPrototype.renderToken;
    const originalHandleMouse = markdownPrototype.handleMouse;
    const stripTerminalStyles = (value: string): string =>
      value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

    const patchedInvalidate = function (this: any) {
      delete this[codeBlockCollectionKey];
      delete this[codeBlockRegionsKey];
      return originalInvalidate.call(this);
    };

    const patchedRender = function (this: any, width: number): string[] {
      const needsRender =
        !this.cachedLines || this.cachedText !== this.text || this.cachedWidth !== width;
      if (needsRender) this[codeBlockCollectionKey] = [];

      const lines = originalRender.call(this, width);
      if (!needsRender) return lines;

      const regions: Array<{ xStart: number; xEnd: number; y: number; code: string }> = [];
      let searchFrom = 0;
      for (const block of this[codeBlockCollectionKey] ?? []) {
        let headerLine = -1;
        for (let lineIndex = searchFrom; lineIndex < lines.length; lineIndex += 1) {
          const renderedLine = lines[lineIndex] ?? "";
          if (
            renderedLine.includes(block.styledTopRule) ||
            stripTerminalStyles(renderedLine).includes(block.topRule)
          ) {
            headerLine = lineIndex;
            break;
          }
        }
        if (headerLine < 0) continue;

        regions.push({
          xStart: Number(this.paddingX ?? 0) + block.buttonStart,
          xEnd: Number(this.paddingX ?? 0) + block.buttonStart + block.buttonWidth,
          y: headerLine,
          code: block.code,
        });
        searchFrom = headerLine + 1;
      }
      this[codeBlockRegionsKey] = regions;
      delete this[codeBlockCollectionKey];
      return lines;
    };

    const patchedRenderToken = function (
      this: any,
      token: any,
      width: number,
      nextTokenType?: string,
      styleContext?: any,
    ): string[] {
      if (token?.type !== "code") {
        return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
      }

      const maxWidth = Math.max(1, width);
      const code = String(token.text ?? "");
      const useRoundedFrame = maxWidth >= 8;
      const maximumCodeWidth = useRoundedFrame ? maxWidth - 4 : maxWidth;
      const highlighted = this.theme.highlightCode
        ? this.theme.highlightCode(code, token.lang)
        : code.split("\n").map((line: string) => this.theme.codeBlock(line));
      const codeLines: string[] = [];
      for (const line of highlighted.length > 0 ? highlighted : [""]) {
        const wrapped = wrapTextWithAnsi(line, maximumCodeWidth);
        codeLines.push(...(wrapped.length > 0 ? wrapped : [""]));
      }

      if (!useRoundedFrame) {
        if (nextTokenType && nextTokenType !== "space") codeLines.push("");
        return codeLines;
      }

      const copyLabel = "[Copy]";
      const showCopyButton = fullscreenTui && maxWidth >= 18;
      const topSuffix = showCopyButton ? ` ${copyLabel} ╮` : "╮";
      const rawLanguage = typeof token.lang === "string" ? token.lang.trim() : "";
      const language = rawLanguage.split(/\s+/, 1)[0] || "code";
      const label = truncateToWidth(
        language,
        Math.max(1, maxWidth - visibleWidth(topSuffix) - 7),
        "…",
      );
      const topPrefix = `╭─ ${label} `;
      const contentWidth = codeLines.reduce(
        (widest, line) => Math.max(widest, visibleWidth(line)),
        0,
      );
      const minimumFrameWidth = visibleWidth(topPrefix) + 3 + visibleWidth(topSuffix);
      const frameWidth = Math.min(maxWidth, Math.max(contentWidth + 4, minimumFrameWidth));
      const fillWidth = Math.max(
        0,
        frameWidth - visibleWidth(topPrefix) - visibleWidth(topSuffix),
      );
      const buttonStart = visibleWidth(topPrefix) + fillWidth + (showCopyButton ? 1 : 0);
      const topRule = topPrefix + "─".repeat(fillWidth) + topSuffix;
      const styledTopRule = this.theme.codeBlockBorder(topRule);
      const framedCodeWidth = Math.max(1, frameWidth - 4);
      const lines = [
        styledTopRule,
        ...codeLines.map((line) =>
          this.theme.codeBlockBorder("│ ") +
          line +
          " ".repeat(Math.max(0, framedCodeWidth - visibleWidth(line))) +
          this.theme.codeBlockBorder(" │")
        ),
        this.theme.codeBlockBorder(`╰${"─".repeat(Math.max(0, frameWidth - 2))}╯`),
      ];

      if (showCopyButton && Array.isArray(this[codeBlockCollectionKey])) {
        this[codeBlockCollectionKey].push({
          buttonStart,
          buttonWidth: visibleWidth(copyLabel),
          code,
          styledTopRule,
          topRule,
        });
      }
      if (nextTokenType && nextTokenType !== "space") lines.push("");
      return lines;
    };

    const patchedHandleMouse = function (this: any, event: TuiMouseEvent) {
      if (event.button === "left" && (event.type === "press" || event.type === "click")) {
        const region = (this[codeBlockRegionsKey] ?? []).find(
          (candidate: any) =>
            event.y === candidate.y && event.x >= candidate.xStart && event.x < candidate.xEnd,
        );
        if (region) {
          if (event.type === "click") {
            if (typeof currentTui?.copyTextToClipboard === "function") {
              // Match fullscreen selection exactly: use Pi TUI's clipboard path
              // and its transient "Copied!" / "Copy failed" flash feedback.
              void Promise.resolve(currentTui.copyTextToClipboard(region.code)).catch(() => {
                currentTui?.flash?.("Copy failed");
              });
            } else {
              // Defensive fallback for older Pi versions without the fullscreen helper.
              void copyToClipboard(region.code)
                .then(() => currentExtensionUi?.notify("Copied!", "info"))
                .catch(() => currentExtensionUi?.notify("Copy failed", "error"));
            }
          }
          return { handled: true, render: false };
        }
      }
      return originalHandleMouse?.call(this, event);
    };

    markdownPrototype[codeBlockPatchKey] = {
      originalHandleMouse,
      originalInvalidate,
      originalRender,
      originalRenderToken,
      patchedHandleMouse,
      patchedInvalidate,
      patchedRender,
      patchedRenderToken,
    };
    markdownPrototype.invalidate = patchedInvalidate;
    markdownPrototype.render = patchedRender;
    markdownPrototype.renderToken = patchedRenderToken;
    markdownPrototype.handleMouse = patchedHandleMouse;

    pi.on("session_shutdown", () => {
      const patch = markdownPrototype[codeBlockPatchKey];
      if (patch?.patchedInvalidate === markdownPrototype.invalidate) {
        markdownPrototype.invalidate = patch.originalInvalidate;
      }
      if (patch?.patchedRender === markdownPrototype.render) {
        markdownPrototype.render = patch.originalRender;
      }
      if (patch?.patchedRenderToken === markdownPrototype.renderToken) {
        markdownPrototype.renderToken = patch.originalRenderToken;
      }
      if (patch?.patchedHandleMouse === markdownPrototype.handleMouse) {
        if (patch.originalHandleMouse) markdownPrototype.handleMouse = patch.originalHandleMouse;
        else delete markdownPrototype.handleMouse;
      }
      if (
        patch &&
        markdownPrototype.invalidate === patch.originalInvalidate &&
        markdownPrototype.render === patch.originalRender &&
        markdownPrototype.renderToken === patch.originalRenderToken &&
        markdownPrototype.handleMouse === patch.originalHandleMouse
      ) {
        delete markdownPrototype[codeBlockPatchKey];
      }
    });
  }

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
    activeToolCallIds: Set<string>;
    groups: ToolSummaryGroup[];
    active: boolean;
    settled: boolean;
  };
  const cleanRun: CleanRunState = {
    count: 0,
    failed: 0,
    currentToolCallIds: [],
    activeToolCallIds: new Set(),
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

  const liveCleanToolCount = (): number =>
    Math.max(cleanRun.count, cleanRun.currentToolCallIds.length);

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
        if (!cleanRun.currentToolCallIds.includes(this.toolCallId)) {
          cleanRun.currentToolCallIds.push(this.toolCallId);
        }
        cleanRun.activeToolCallIds.add(this.toolCallId);
        cleanToolNames.set(this.toolCallId, toolDisplayName(this.toolName));
        setCleanGroupMembers(this.toolCallId, cleanRun.currentToolCallIds.slice());
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
        !isCleanGroupRevealed(this.toolCallId) &&
        groupToolCallIds?.length
      ) {
        revealCleanGroup(groupToolCallIds, this.ui);
        return;
      }
      return originalSetExpanded.call(this, expanded);
    };
    const patchedToolRender = function (this: any, width: number): string[] {
      if (supportedTools.has(this.toolName)) {
        cleanToolComponents.set(this.toolCallId, this);
        knownToolCallIds.add(this.toolCallId);
      }
      if (this[renderedModeKey] !== renderMode) {
        this[renderedModeKey] = renderMode;
        this.updateDisplay();
      }

      const groupOwner = cleanToolCallGroupOwners.get(this.toolCallId);
      const groupToolCallIds = groupOwner ? cleanGroupToolCallIds.get(groupOwner) : undefined;
      const childIndex = groupToolCallIds?.indexOf(this.toolCallId) ?? -1;
      const showAsChild = renderMode === "clean" && childIndex >= 0 && isCleanGroupRevealed(this.toolCallId);
      if (!showAsChild || !groupOwner || !groupToolCallIds) {
        return originalToolRender.call(this, width);
      }

      const rawChildPrefix = childIndex === groupToolCallIds.length - 1 ? "  └─ " : "  ├─ ";
      const rawContinuation = childIndex === groupToolCallIds.length - 1 ? "     " : "  │  ";
      const childTheme = cleanThemeForToolCall(this.toolCallId);
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
      const showAsChild = renderMode === "clean" && childIndex >= 0 && isCleanGroupRevealed(this.toolCallId);
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
    cleanRun.activeToolCallIds.clear();
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
    collapsedDone = false,
  ): DisplayRow => ({
    prefix: () => {
      const currentActivity = typeof activity === "function" ? activity() : activity;
      const color = currentActivity === "done"
        ? collapsedDone ? "thinkingText" : "success"
        : "accent";
      return theme.fg(color, "● ");
    },
    continuation: "  ",
    content: () => {
      const currentActivity = typeof activity === "function" ? activity() : activity;
      const label = currentActivity === "done" ? "Done" : "Running";
      const color = label === "Done"
        ? collapsedDone ? "thinkingText" : "success"
        : "accent";
      const detailColor = label === "Done" && collapsedDone ? "thinkingText" : "text";
      return theme.fg(color, theme.bold(label)) +
        theme.fg("dim", "(") +
        theme.fg(detailColor, summaryText(count, failed, currentActivity)) + theme.fg("dim", ")");
    },
  });

  renderCleanGroupSummary = (lastToolCallId: string, width: number): string[] => {
    const summaryTheme = cleanThemeForToolCall(lastToolCallId);
    if (!summaryTheme) return [];
    const settled = settledSummaries.get(lastToolCallId);
    if (settled) {
      return block([summaryRow(summaryTheme, settled.count, settled.failed, settled.activity)]).render(width);
    }
    if (cleanRun.activeToolCallId === lastToolCallId) {
      return block([summaryRow(
        summaryTheme,
        liveCleanToolCount(),
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
          return block([summaryRow(
            theme,
            settledSummary.count,
            settledSummary.failed,
            settledSummary.activity,
            true,
          )]).render(width);
        }
        if (cleanRun.settled) return [];

        if (cleanRun.activeToolCallId === toolCallId) {
          return block([summaryRow(
            theme,
            liveCleanToolCount(),
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
  ): boolean => renderMode === "clean" && !expanded && !isCleanGroupRevealed(toolCallId);

  const useCompactToolView = (toolCallId: string, expanded: boolean): boolean =>
    !expanded && (
      renderMode === "compact" ||
      (renderMode === "clean" && isCleanGroupRevealed(toolCallId))
    );

  pi.registerEntryRenderer<ToolSummaryData>("pretty-tui-tool-summary", (entry, { expanded }, theme) => ({
    render(width: number): string[] {
      if (renderMode !== "clean" || expanded || cleanContextCompacted) return [];
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
      // entry as a fallback only for groups whose components are unexpectedly
      // absent from an uncompacted branch.
      const missingGroups = groups.filter((group) => !knownToolCallIds.has(group.lastToolCallId));
      if (missingGroups.length === 0) return [];
      // Persisted entries represent settled groups. Older versions could
      // accidentally store the transient responding... activity, so always
      // normalize their display to Done.
      return block(missingGroups.map((group) =>
        summaryRow(theme, group.count, group.failed, "done", true)
      )).render(width);
    },
    invalidate() {},
  }));

  const messageContentItems = (message: any): any[] =>
    Array.isArray(message?.content) ? message.content : [];

  const messageHasVisibleText = (message: any): boolean =>
    typeof message?.content === "string"
      ? message.content.trim().length > 0
      : messageContentItems(message).some(
          (item: any) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
        );

  const restoreCleanSession = (ctx: any) => {
    currentExtensionUi = ctx.ui;
    cleanToolsExpanded = ctx.ui.getToolsExpanded();
    settledSummaries.clear();
    legacySummaryLastToolCallIds.clear();
    knownToolCallIds.clear();
    cleanCompactToolCallIds.clear();
    cleanGroupToolCallIds.clear();
    cleanToolCallGroupOwners.clear();
    cleanToolComponents.clear();
    cleanToolThemes.clear();
    cleanToolNames.clear();
    clearToolActivityHolds();
    cleanRun.requestRender = undefined;
    cleanRun.count = 0;
    cleanRun.failed = 0;
    cleanRun.currentToolCallIds = [];
    cleanRun.activeToolCallIds.clear();
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
    const inferredGroups: ToolSummaryGroup[] = [];
    const toolCalls = new Set<string>();
    const completedToolCalls = new Set<string>();
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
        inferredGroups.push(lastFinishedGroup);
        setCleanGroupMembers(lastToolCallId, [...toolCalls]);
        if (!explicitSummaryIds.has(lastToolCallId)) {
          settledSummaries.set(lastToolCallId, { count, failed, activity: "done" });
        }
      }
      count = 0;
      failed = 0;
      lastToolCallId = undefined;
      toolCalls.clear();
      completedToolCalls.clear();
    };

    const inferredGroupsOverlapping = (group: ToolSummaryGroup): ToolSummaryGroup[] => {
      if (!group.toolCallIds?.length) return [];
      const persistedIds = new Set(group.toolCallIds);
      const currentGroup = lastToolCallId && count > 0
        ? [{ count, failed, lastToolCallId, toolCallIds: [...toolCalls] }]
        : [];
      return [...inferredGroups, ...currentGroup].filter((inferred) =>
        inferred.toolCallIds?.some((toolCallId) => persistedIds.has(toolCallId)),
      );
    };

    const splitSummaryAtTranscriptBoundaries = (group: ToolSummaryGroup): ToolSummaryGroup[] => {
      if (!group.toolCallIds?.length) return [group];
      const persistedIds = new Set(group.toolCallIds);
      const overlappingGroups = inferredGroupsOverlapping(group);
      if (overlappingGroups.length <= 1) return [group];

      // Older clean-mode summaries could span steering or compaction because
      // only visible assistant text ended a live group. Prefer the transcript's
      // hard boundaries so parent rows and expanded children stay chronological.
      return overlappingGroups.map((inferred) => ({
        ...inferred,
        toolCallIds: inferred.toolCallIds?.filter((toolCallId) => persistedIds.has(toolCallId)),
      }));
    };

    const replaceInferredGroupsWithSummary = (
      persistedGroup: ToolSummaryGroup,
      restoredGroups: ToolSummaryGroup[],
    ) => {
      const restoredOwners = new Set(restoredGroups.map((group) => group.lastToolCallId));
      for (const inferred of inferredGroupsOverlapping(persistedGroup)) {
        if (!restoredOwners.has(inferred.lastToolCallId)) {
          settledSummaries.delete(inferred.lastToolCallId);
        }
      }
      for (const group of restoredGroups) rememberGroup(group);
    };

    const consumeGroupCoveredBySummary = (groups: ToolSummaryGroup[]) => {
      if (toolCalls.size === 0) return;
      const coveredToolCallIds = new Set(
        groups.flatMap((group) => [group.lastToolCallId, ...(group.toolCallIds ?? [])]),
      );
      if (![...toolCalls].some((toolCallId) => coveredToolCallIds.has(toolCallId))) return;

      // A durable summary closes the current run even if the session contains
      // an orphaned tool call without a toolResult. Do not infer a second,
      // larger Done row when the following user message closes the transcript group.
      count = 0;
      failed = 0;
      lastToolCallId = undefined;
      lastFinishedGroup = undefined;
      toolCalls.clear();
      completedToolCalls.clear();
    };

    // Use the same compaction-aware branch that Pi renders in the transcript;
    // getEntries() can also contain entries from other branches.
    const modelContextEntries = ctx.sessionManager.buildContextEntries();
    cleanContextCompacted = modelContextEntries[0]?.type === "compaction";
    const contextEntries = orderContextEntriesForTranscript(modelContextEntries);
    for (const entry of contextEntries) {
      if (entry.type === "compaction") {
        finishGroup();
        lastFinishedGroup = undefined;
        continue;
      }
      if (entry.type === "custom" && entry.customType === "pretty-tui-tool-summary") {
        const data = entry.data as ToolSummaryData | undefined;
        if (data?.groups?.length) {
          const validGroups = data.groups.filter(
            (group): group is ToolSummaryGroup => Boolean(group?.lastToolCallId && group.count > 0),
          );
          for (const group of validGroups) {
            const restoredGroups = splitSummaryAtTranscriptBoundaries(group);
            replaceInferredGroupsWithSummary(group, restoredGroups);
          }
          consumeGroupCoveredBySummary(validGroups);
        } else if (data?.lastToolCallId) {
          const group = {
            count: data.count ?? 0,
            failed: data.failed ?? 0,
            lastToolCallId: data.lastToolCallId,
          };
          rememberGroup(group);
          consumeGroupCoveredBySummary([group]);
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
        if (messageHasVisibleText(message)) finishGroup();
        for (const item of messageContentItems(message)) {
          if (item.type !== "toolCall" || !supportedTools.has(item.name)) continue;
          toolCalls.add(item.id);
        }
        continue;
      }

      if (
        message.role === "toolResult" &&
        toolCalls.has(message.toolCallId) &&
        !completedToolCalls.has(message.toolCallId)
      ) {
        completedToolCalls.add(message.toolCallId);
        count++;
        lastToolCallId = message.toolCallId;
        if (message.isError) failed++;
      }
    }

    finishGroup();
  };

  pi.on("session_start", (_event, ctx) => restoreCleanSession(ctx));
  pi.on("session_tree", (_event, ctx) => restoreCleanSession(ctx));
  pi.on("session_compact", () => {
    // Compaction is a hard chronological boundary. Keep tools completed before
    // it in their own group so expanded hierarchy lines never cross the summary.
    finishCleanGroup("done");
    settleLastCleanGroup();
    // Pre-compaction tools have been summarized intentionally. Their durable
    // fallback rows should not be replayed beside the compacted transcript.
    cleanContextCompacted = true;
  });

  const hasVisibleAssistantText = (message: any): boolean =>
    message?.role === "assistant" && messageHasVisibleText(message);

  const pendingToolCalls = (message: any): any[] =>
    messageContentItems(message).filter(
      (item: any) => item.type === "toolCall" && supportedTools.has(item.name) && item.id,
    );

  const trackPendingToolActivity = (message: any): boolean => {
    const toolCalls = pendingToolCalls(message);
    if (toolCalls.length === 0) return false;
    for (const toolCall of toolCalls) {
      if (!cleanRun.currentToolCallIds.includes(toolCall.id)) {
        cleanRun.currentToolCallIds.push(toolCall.id);
      }
      cleanToolNames.set(toolCall.id, toolDisplayName(toolCall.name));
    }
    const toolCall = toolCalls[toolCalls.length - 1];
    if (cleanRun.lastCompletedToolCallId === toolCall.id) return false;
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

  // A delivered steering message is also a chronological group boundary.
  // message_start runs before Pi adds the user component to the transcript,
  // so settling here keeps the previous parent row above that message.
  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    finishCleanGroup("done");
    settleLastCleanGroup();
  });

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
      cleanRun.activeToolCallIds.clear();
      cleanRun.groups = [];
      cleanRun.lastCompletedToolCallId = undefined;
      cleanRun.settled = false;
    }
    cleanRun.active = true;
    cleanRun.activeToolCallIds.clear();
    cleanRun.activeToolCallId = undefined;
    cleanRun.activeToolName = undefined;
    cleanRun.activity = "thinking...";
  });
  pi.on("tool_execution_start", (event) => {
    if (!supportedTools.has(event.toolName)) return;
    if (!cleanRun.currentToolCallIds.includes(event.toolCallId)) {
      cleanRun.currentToolCallIds.push(event.toolCallId);
    }
    cleanRun.activeToolCallIds.add(event.toolCallId);
    cleanToolNames.set(event.toolCallId, toolDisplayName(event.toolName));
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
    cleanRun.activeToolCallIds.delete(event.toolCallId);
    if (cleanRun.activeToolCallId === event.toolCallId) {
      cleanRun.activeToolCallId = [...cleanRun.currentToolCallIds]
        .reverse()
        .find((toolCallId) => cleanRun.activeToolCallIds.has(toolCallId));
      cleanRun.activeToolName = cleanRun.activeToolCallId
        ? cleanToolNames.get(cleanRun.activeToolCallId)
        : undefined;
      cleanRun.activity = cleanRun.activeToolName ?? "thinking...";
    }
    const visibleSummaryToolCallId = cleanRun.activeToolCallId ?? cleanRun.lastCompletedToolCallId;
    setCleanGroupMembers(visibleSummaryToolCallId, cleanRun.currentToolCallIds.slice());
  });
  pi.on("agent_end", () => {
    // No summary is appended here: this event may be followed by an automatic
    // retry or compaction. The live row remains available until settled.
    clearPendingToolActivities();
    cleanRun.activeToolCallIds.clear();
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
    cleanRun.activeToolCallIds.clear();
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

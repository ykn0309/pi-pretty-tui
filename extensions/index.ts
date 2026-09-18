import {
  AssistantMessageComponent,
  CustomEditor,
  CustomMessageComponent,
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
  getMarkdownTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  stripTerminalSequences,
  truncateToWidth,
  TuiAltScreen,
  type TuiMouseEvent,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActivityTimeline,
  assistantMessageKey,
  assistantSystemBoundary,
  thinkingText,
  visibleAssistantText,
  type ActivityGroup,
  type ActivityMember,
} from "./activity-timeline.js";

type PrettyTuiMode = "full" | "compact" | "clean";
const CLEAN_TOOL_ACTIVITY_MIN_MS = 1000;
const SPECIALIZED_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const stripAnsiBackgrounds = (value: string): string =>
  value.replace(/\x1b\[([0-9:;]*)m/g, (sequence, raw: string) => {
    const fields = raw === "" ? [0] : raw.split(";").map((field) => Number(field));
    const kept: number[] = [];
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index];
      if ((field >= 40 && field <= 49) || (field >= 100 && field <= 107)) continue;
      if (field === 48) {
        const mode = fields[index + 1];
        if (mode === 5) index += 2;
        else if (mode === 2) index += 4;
        continue;
      }
      kept.push(field);
    }
    if (raw.includes(":") && /(?:^|;)48:/u.test(raw)) return "";
    return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
  });
type PrettyTuiConfig = {
  enabled?: boolean;
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
  const activeForSession = config.enabled !== false;
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
  const activityTimeline = new ActivityTimeline();
  const revealedActivityGroups = new Set<string>();
  const expandedThinkingMembers = new Set<string>();
  const thinkingComponents = new Map<string, any>();
  const activityFallbackThemes = new Map<string, any>();
  const activityUpdateComponents = new Map<string, Component>();
  const customUpdateToolHints = new Map<string, string>();
  const customUpdateBeforeToolHints = new Set<string>();
  let activityUpdateSequence = 0;
  const assistantBoundaryKeys = new Set<string>();
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
    const activityGroup = activityTimeline.groupForTool(toolCallId);
    if (activityGroup && activityGroupRevealed(activityGroup)) return true;
    const legacyOwner = cleanToolCallGroupOwners.get(toolCallId);
    const legacyIds = legacyOwner ? cleanGroupToolCallIds.get(legacyOwner) : undefined;
    return legacyIds?.some((id) => cleanCompactToolCallIds.has(id)) ?? false;
  };

  const cleanThemeForToolCall = (toolCallId: string): any => {
    const directTheme = cleanToolThemes.get(toolCallId);
    if (directTheme) return directTheme;
    const activityGroup = activityTimeline.groupForTool(toolCallId);
    // Prefer a real tool renderer theme over the Markdown-derived fallback.
    // A group that starts with Thought installs the fallback first; returning
    // it here made later third-party success dots use the heading color.
    if (activityGroup) {
      for (const id of activityGroup.toolCallIds) {
        const activityTheme = cleanToolThemes.get(id);
        if (activityTheme) {
          activityFallbackThemes.set(activityGroup.id, activityTheme);
          return activityTheme;
        }
      }
    }
    const cachedActivityTheme = activityGroup
      ? activityFallbackThemes.get(activityGroup.id)
      : undefined;
    if (cachedActivityTheme) return cachedActivityTheme;
    const legacyOwner = cleanToolCallGroupOwners.get(toolCallId);
    const legacyIds = legacyOwner ? cleanGroupToolCallIds.get(legacyOwner) : undefined;
    return legacyIds?.map((id) => cleanToolThemes.get(id)).find(Boolean);
  };

  const activityGroupOwner = (group: ActivityGroup): string | undefined => {
    for (let index = group.toolCallIds.length - 1; index >= 0; index--) {
      const toolCallId = group.toolCallIds[index];
      if (settledSummaries.has(toolCallId)) return toolCallId;
    }
    if (cleanRun.activeToolCallId && group.toolCallIds.includes(cleanRun.activeToolCallId)) {
      return cleanRun.activeToolCallId;
    }
    if (cleanRun.lastCompletedToolCallId && group.toolCallIds.includes(cleanRun.lastCompletedToolCallId)) {
      return cleanRun.lastCompletedToolCallId;
    }
    return group.toolCallIds[group.toolCallIds.length - 1];
  };

  const defaultActivityTheme = () => {
    const markdownTheme = getMarkdownTheme();
    return {
      fg: (color: string, text: string) => {
        if (color === "accent") return markdownTheme.listBullet(text);
        if (color === "success" || color === "syntaxComment") return markdownTheme.codeBlock(text);
        if (color === "thinkingLow") return markdownTheme.link(text);
        if (color === "dim" || color === "muted" || color === "thinkingText") {
          return markdownTheme.quote(text);
        }
        return text;
      },
      bold: markdownTheme.bold,
      italic: markdownTheme.italic,
    };
  };

  const activityGroupTheme = (group: ActivityGroup): any => {
    // A Thought can render before its tools are constructed and install a
    // Markdown fallback. Always promote a real tool theme once available so
    // light mode receives explicit, high-contrast text colors.
    for (const toolCallId of group.toolCallIds) {
      const toolTheme = cleanToolThemes.get(toolCallId);
      if (toolTheme) {
        activityFallbackThemes.set(group.id, toolTheme);
        return toolTheme;
      }
    }
    const cached = activityFallbackThemes.get(group.id);
    if (cached) return cached;
    const fallback = defaultActivityTheme();
    activityFallbackThemes.set(group.id, fallback);
    return fallback;
  };

  const activityGroupRevealed = (group: ActivityGroup): boolean =>
    cleanToolsExpanded || revealedActivityGroups.has(group.id);

  const activityMemberPosition = (group: ActivityGroup, member: ActivityMember) => ({
    first: group.members[0]?.id === member.id,
    last: group.members[group.members.length - 1]?.id === member.id,
  });

  const activityTreeStyle = (
    group: ActivityGroup,
    member: ActivityMember,
    width: number,
    memberTheme?: any,
  ) => {
    const { last } = activityMemberPosition(group, member);
    const rawPrefix = last ? "  └─ " : "  ├─ ";
    const rawContinuation = last ? "     " : "  │  ";
    const prefixWidth = visibleWidth(rawPrefix);
    if (width <= prefixWidth) {
      return { prefix: "", continuation: "", childWidth: Math.max(1, width), prefixWidth: 0 };
    }
    const resolvedTheme = memberTheme ?? activityGroupTheme(group);
    return {
      prefix: resolvedTheme ? resolvedTheme.fg("dim", rawPrefix) : rawPrefix,
      continuation: resolvedTheme ? resolvedTheme.fg("dim", rawContinuation) : rawContinuation,
      childWidth: Math.max(1, width - prefixWidth),
      prefixWidth,
    };
  };

  const humanizeCustomType = (value: string): string =>
    value
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || "Update";

  const renderActivityUpdate = (
    group: ActivityGroup,
    member: ActivityMember,
    width: number,
    theme = activityGroupTheme(group),
  ): string[] => {
    if (renderMode !== "clean" || !activityGroupRevealed(group)) return [];
    const { prefix, continuation, childWidth } = activityTreeStyle(group, member, width, theme);
    const title = truncateToWidth(member.updateTitle ?? "Update", Math.max(1, childWidth - 2), "…");
    const lines = [theme.fg("accent", "◇ ") + theme.fg("toolTitle", theme.bold(title))];
    if (member.updateContent) {
      const detailWidth = Math.max(1, childWidth - visibleWidth("  │ "));
      const detailLines = wrapTextWithAnsi(theme.fg("muted", member.updateContent), detailWidth);
      lines.push(...detailLines.map((line, index) =>
        theme.fg("dim", index === detailLines.length - 1 ? "  └ " : "  │ ") + line
      ));
    }
    const decorated = lines.map((line, index) =>
      truncateToWidth((index === 0 ? prefix : continuation) + line, Math.max(1, width), "")
    );
    const position = activityMemberPosition(group, member);
    return position.first
      ? ["", ...renderActivityGroupSummary(group, width), ...decorated]
      : decorated;
  };

  const renderPendingActivityUpdate = (member: ActivityMember, width: number): string[] => {
    const theme = defaultActivityTheme();
    const title = truncateToWidth(member.updateTitle ?? "Update", Math.max(1, width - 2), "…");
    const lines = [theme.fg("accent", "◇ ") + theme.fg("toolTitle", theme.bold(title))];
    if (member.updateContent) {
      const detailWidth = Math.max(1, width - visibleWidth("  │ "));
      const details = wrapTextWithAnsi(theme.fg("muted", member.updateContent), detailWidth);
      lines.push(...details.map((line, index) =>
        theme.fg("dim", index === details.length - 1 ? "  └ " : "  │ ") + line
      ));
    }
    return ["", ...lines.map((line) => truncateToWidth(line, Math.max(1, width), ""))];
  };

  const handleActivityUpdateMouse = (
    group: ActivityGroup,
    member: ActivityMember,
    event: any,
  ) => {
    const isLeftClick = event.type === "click" && event.button === "left";
    if (!isLeftClick || group.toolCallIds.length === 0) return undefined;
    const position = activityMemberPosition(group, member);
    if (!activityGroupRevealed(group)) {
      if (!position.first) return undefined;
      revealedActivityGroups.add(group.id);
      for (const toolCallId of group.toolCallIds) cleanCompactToolCallIds.add(toolCallId);
    } else {
      const summaryHeight = position.first ? renderActivityGroupSummary(group, event.width).length : 0;
      if (!position.first || event.y <= 0 || event.y > summaryHeight) return undefined;
      revealedActivityGroups.delete(group.id);
      for (const toolCallId of group.toolCallIds) {
        cleanCompactToolCallIds.delete(toolCallId);
        const component = cleanToolComponents.get(toolCallId);
        if (component?.expanded) component.setExpanded(false);
      }
      for (const child of group.members) expandedThinkingMembers.delete(child.id);
    }
    for (const child of group.members) {
      if (child.kind === "tool" && child.toolCallId) {
        cleanToolComponents.get(child.toolCallId)?.updateDisplay?.();
      } else if (child.kind === "thinking" && child.messageKey) {
        thinkingComponents.get(child.messageKey)?.invalidate?.();
      }
    }
    currentTui?.requestRender?.();
    return { handled: true };
  };

  const saveConfig = (nextConfig: Record<string, any>) => {
    config = nextConfig;
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  const saveRenderMode = (mode: PrettyTuiMode) => saveConfig({ ...config, mode });
  const saveEnabled = (enabled: boolean) => saveConfig({ ...config, enabled });

  pi.registerCommand("pretty-tui", {
    description: "Configure pi-pretty-tui",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "enable", label: "enable", description: "Enable the extension and reload automatically" },
        { value: "disable", label: "disable", description: "Disable the extension and reload automatically" },
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
          ctx.ui.notify(
            `pi-pretty-tui: ${config.enabled !== false ? "enabled" : "disabled"} · mode: ${renderMode}`,
            "info",
          );
          return;
        }
        const enabled = `Enabled — ${config.enabled !== false ? "on" : "off"}`;
        const full = `Full — full tool details and output${renderMode === "full" ? " (current)" : ""}`;
        const compact = `Compact — concise summaries for all built-in tools${renderMode === "compact" ? " (current)" : ""}`;
        const clean = `Clean — group supported tools into Running/Done status${renderMode === "clean" ? " (current)" : ""}`;
        const selected = await ctx.ui.select("pi-pretty-tui settings", [enabled, full, compact, clean]);
        if (!selected) return;
        requested = selected === enabled
          ? config.enabled !== false ? "disable" : "enable"
          : selected === full
            ? "full"
            : selected === compact
              ? "compact"
              : "clean";
      }

      if (requested === "status") {
        ctx.ui.notify(
          `pi-pretty-tui: ${config.enabled !== false ? "enabled" : "disabled"} · mode: ${renderMode}`,
          "info",
        );
        return;
      }
      if (requested === "enable" || requested === "disable") {
        const enabled = requested === "enable";
        try {
          saveEnabled(enabled);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not save pi-pretty-tui setting: ${message}`, "error");
          return;
        }
        ctx.ui.notify(
          `pi-pretty-tui ${enabled ? "enabled" : "disabled"}; reloading…`,
          "info",
        );
        try {
          await ctx.reload();
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Setting saved, but automatic reload failed: ${message}`, "warning");
          return;
        }
      }
      if (requested !== "full" && requested !== "compact" && requested !== "clean") {
        ctx.ui.notify("Usage: /pretty-tui [enable|disable|full|compact|clean|status]", "error");
        return;
      }

      cleanCompactToolCallIds.clear();
      revealedActivityGroups.clear();
      expandedThinkingMembers.clear();
      renderMode = requested;
      for (const component of cleanToolComponents.values()) component.updateDisplay?.();
      for (const component of thinkingComponents.values()) component.invalidate?.();
      try {
        saveRenderMode(renderMode);
        ctx.ui.notify(`pi-pretty-tui mode set to: ${renderMode}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Mode changed for this session, but could not save settings: ${message}`, "warning");
      }
    },
  });

  // Keep the settings command available while disabled, but do not install
  // render patches or override built-in tools until the next enabled reload.
  if (!activeForSession) return;

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

  const customMessageKey = (message: any): string => {
    if (message?.timestamp !== undefined) {
      const parsed = typeof message.timestamp === "string"
        ? Date.parse(message.timestamp)
        : Number(message.timestamp);
      return Number.isFinite(parsed) ? String(parsed) : String(message.timestamp);
    }
    return `${message?.customType ?? "custom"}:${JSON.stringify(message?.content ?? "")}`;
  };

  const customMessageText = (message: any): string =>
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
          .filter((item: any) => item?.type === "text" && typeof item.text === "string")
          .map((item: any) => item.text)
          .join("\n")
        : "";

  const addPersistentActivityUpdate = (message: any): ActivityMember => {
    const key = customMessageKey(message);
    const title = humanizeCustomType(message?.customType ?? "update");
    const content = customMessageText(message);
    return activityTimeline.addUpdate(key, title, content, true) ??
      activityTimeline.addPendingUpdate(key, title, content, true);
  };

  const customMessagePrototype = CustomMessageComponent.prototype as any;
  const customMessagePatchKey = Symbol.for("pretty-tui.clean-custom-message");
  if (!customMessagePrototype[customMessagePatchKey]) {
    const originalCustomRender = customMessagePrototype.render;
    const originalCustomHandleMouse = customMessagePrototype.handleMouse;
    const patchedCustomRender = function (this: any, width: number): string[] {
      const message = this.message;
      const key = customMessageKey(message);
      let member = activityTimeline.memberForUpdate(key);
      if (!member) {
        const hintedToolCallId = customUpdateToolHints.get(key);
        const hintedGroup = hintedToolCallId
          ? activityTimeline.groupForTool(hintedToolCallId)
          : undefined;
        if (hintedGroup) {
          const attach = customUpdateBeforeToolHints.has(key)
            ? activityTimeline.addUpdateToGroupStart.bind(activityTimeline)
            : activityTimeline.addUpdateToGroup.bind(activityTimeline);
          member = attach(
            hintedGroup.id,
            key,
            humanizeCustomType(message?.customType ?? "update"),
            customMessageText(message),
            true,
          );
        }
      }
      const group = member ? activityTimeline.groupForMember(member.id) : undefined;
      if (renderMode !== "clean" || !member || !group) {
        return originalCustomRender.call(this, width);
      }
      activityUpdateComponents.set(member.id, this);
      if (group.toolCallIds.length === 0) return renderPendingActivityUpdate(member, width);
      const position = activityMemberPosition(group, member);
      if (!activityGroupRevealed(group)) {
        return position.first
          ? ["", ...renderActivityGroupSummary(group, width, true)]
          : [];
      }
      return renderActivityUpdate(group, member, width);
    };
    const patchedCustomHandleMouse = function (this: any, event: any) {
      const member = activityTimeline.memberForUpdate(customMessageKey(this.message));
      const group = member ? activityTimeline.groupForMember(member.id) : undefined;
      if (renderMode !== "clean" || !member || !group) {
        return originalCustomHandleMouse?.call(this, event);
      }
      if (group.toolCallIds.length === 0) return undefined;
      return handleActivityUpdateMouse(group, member, event);
    };
    customMessagePrototype[customMessagePatchKey] = {
      originalRender: originalCustomRender,
      patchedRender: patchedCustomRender,
      originalHandleMouse: originalCustomHandleMouse,
      patchedHandleMouse: patchedCustomHandleMouse,
    };
    customMessagePrototype.render = patchedCustomRender;
    customMessagePrototype.handleMouse = patchedCustomHandleMouse;
    pi.on("session_shutdown", () => {
      const patch = customMessagePrototype[customMessagePatchKey];
      if (!patch) return;
      if (patch.patchedRender === customMessagePrototype.render) {
        customMessagePrototype.render = patch.originalRender;
      }
      if (patch.patchedHandleMouse === customMessagePrototype.handleMouse) {
        customMessagePrototype.handleMouse = patch.originalHandleMouse;
      }
      if (
        customMessagePrototype.render === patch.originalRender &&
        customMessagePrototype.handleMouse === patch.originalHandleMouse
      ) {
        delete customMessagePrototype[customMessagePatchKey];
      }
    });
  }

  // Thinking and tools are peers in the transcript-first activity timeline.
  // Assistant components keep Pi's native Markdown renderer, while clean mode
  // projects each thinking run as a compact, independently expandable child.
  const assistantPrototype = AssistantMessageComponent.prototype as any;
  const thinkingPatchKey = Symbol.for("pretty-tui.clean-thinking");
  if (!assistantPrototype[thinkingPatchKey]) {
    const originalUpdateContent = assistantPrototype.updateContent;
    const originalRender = assistantPrototype.render;
    const originalHandleMouse = assistantPrototype.handleMouse;
    const originalMessageKey = Symbol("pretty-tui.original-assistant-message");
    const renderedModeKey = Symbol("pretty-tui.rendered-assistant-mode");
    const renderedExpansionKey = Symbol("pretty-tui.rendered-assistant-expansion");
    const cleanThinkingRenderCacheKey = Symbol("pretty-tui.clean-thinking-render-cache");
    const cleanThinkingDetailKey = Symbol("pretty-tui.clean-thinking-detail");

    const eligibleThinking = (message: any) =>
      Array.isArray(message?.content) &&
      message.content.some(
        (item: any) => item?.type === "thinking" &&
          typeof item.thinking === "string" &&
          item.thinking.length > 0,
      ) &&
      !assistantSystemBoundary(message);

    const refreshGroup = (group: ActivityGroup) => {
      for (const member of group.members) {
        if (member.kind === "tool" && member.toolCallId) {
          cleanToolComponents.get(member.toolCallId)?.updateDisplay?.();
        } else if (member.kind === "thinking" && member.messageKey) {
          thinkingComponents.get(member.messageKey)?.invalidate?.();
        }
      }
      currentTui?.requestRender?.();
    };

    const patchedUpdateContent = function (this: any, message: any, isStreaming = this.isStreaming) {
      this[originalMessageKey] = message;
      this[renderedModeKey] = renderMode;
      this[renderedExpansionKey] = cleanToolsExpanded;
      this.lastMessage = message;
      if (renderMode !== "clean") {
        originalUpdateContent.call(this, message, isStreaming);
        this.lastMessage = message;
        return;
      }
      const groupedThinking = eligibleThinking(message);
      if (groupedThinking) {
        const key = assistantMessageKey(message);
        activityTimeline.addThinking(key, thinkingText(message));
        thinkingComponents.set(key, this);
      }

      const previousHideThinkingBlock = this.hideThinkingBlock;
      this.hideThinkingBlock = false;
      // Clean mode owns grouped thinking completely. Removing it from Pi's
      // native content tree also removes the native MouseRegion that would
      // otherwise toggle a second, unrelated `Thinking...` block.
      const displayMessage =
        groupedThinking && Array.isArray(message?.content)
          ? { ...message, content: message.content.filter((item: any) => item.type !== "thinking") }
          : message;
      try {
        originalUpdateContent.call(this, displayMessage, isStreaming);
      } finally {
        this.hideThinkingBlock = previousHideThinkingBlock;
      }
      this.lastMessage = message;
    };

    const patchedRender = function (this: any, width: number): string[] {
      const message = this[originalMessageKey] ?? this.lastMessage;
      if (
        message &&
        (this[renderedModeKey] !== renderMode || this[renderedExpansionKey] !== cleanToolsExpanded)
      ) {
        patchedUpdateContent.call(this, message, this.isStreaming);
      }
      if (renderMode !== "clean" || !eligibleThinking(message)) {
        return originalRender.call(this, width);
      }

      const key = assistantMessageKey(message);
      const member = activityTimeline.memberForThinking(key);
      const group = member ? activityTimeline.groupForMember(member.id) : undefined;
      if (!member || !group) {
        // Timeline ownership can be briefly unavailable during transcript
        // rebuilds. Fail open to Pi's filtered native renderer so visible
        // assistant text is never lost.
        return originalRender.call(this, width);
      }
      if (group.toolCallIds.length === 0) {
        // Activity groups are tool-oriented. A model may finish with Thinking
        // and visible text without calling a tool; only the Thinking portion
        // is filtered from Pi's native component, so always preserve the
        // visible response here instead of returning an empty projection.
        return visibleAssistantText(message) ? originalRender.call(this, width) : [];
      }
      thinkingComponents.set(key, this);
      if (!activityFallbackThemes.has(group.id)) {
        activityFallbackThemes.set(group.id, defaultActivityTheme());
      }
      const position = activityMemberPosition(group, member);
      const visibleLines = visibleAssistantText(message) ? originalRender.call(this, width) : [];
      const revealed = activityGroupRevealed(group);
      if (!revealed) {
        const activityLines = position.first
          ? ["", ...renderActivityGroupSummary(group, width, true)]
          : [];
        return [...activityLines, ...visibleLines];
      }

      const groupTheme = activityGroupTheme(group);
      const { prefix, continuation, childWidth } = activityTreeStyle(
        group,
        member,
        width,
        groupTheme,
      );
      const expanded = cleanToolsExpanded || expandedThinkingMembers.has(member.id);
      const settledOwner = position.first ? activityGroupOwner(group) : undefined;
      const stableSummary = !position.first || Boolean(
        settledOwner && settledSummaries.has(settledOwner) && !toolActivityHolds.has(settledOwner),
      );
      const cacheable = !expanded && !this.isStreaming && stableSummary;
      const cached = cacheable ? this[cleanThinkingRenderCacheKey] : undefined;
      if (
        cached?.width === width &&
        cached?.message === message &&
        cached?.theme === groupTheme &&
        cached?.memberCount === group.members.length &&
        cached?.last === position.last
      ) {
        // Only the stable activity projection is cached. Visible assistant
        // text belongs outside the collapsible group and must be appended on
        // every render, including cache hits.
        return [...cached.lines, ...visibleLines];
      }
      const stateLabel = this.isStreaming ? "thinking" : "thought";
      const label = truncateToWidth(stateLabel, Math.max(1, childWidth - 2), "…");
      const header = groupTheme.fg("thinkingLow", "● ") +
        groupTheme.fg("toolTitle", groupTheme.bold(label));
      let contentLines: string[] = [header];
      if (expanded) {
        const detailWidth = Math.max(1, childWidth - visibleWidth("  │ "));
        const detailText = member.thinking ?? thinkingText(message);
        let detail = this[cleanThinkingDetailKey];
        if (!detail || detail.text !== detailText) {
          detail = {
            text: detailText,
            component: new Markdown(
              detailText,
              0,
              0,
              this.markdownTheme,
              {
                color: (text: string) => groupTheme.fg("thinkingText", text),
                italic: true,
              },
            ),
          };
          this[cleanThinkingDetailKey] = detail;
        }
        const detailLines = detail.component.render(detailWidth);
        contentLines.push(...detailLines.map((line: string, index: number) =>
          groupTheme.fg("dim", index === detailLines.length - 1 ? "  └ " : "  │ ") + line
        ));
      }
      const decorated = contentLines.map((line, index) =>
        truncateToWidth((index === 0 ? prefix : continuation) + line, Math.max(1, width), "")
      );
      const output = position.first
        ? ["", ...renderActivityGroupSummary(group, width), ...decorated]
        : decorated;
      if (cacheable) {
        this[cleanThinkingRenderCacheKey] = {
          width,
          message,
          theme: groupTheme,
          memberCount: group.members.length,
          last: position.last,
          lines: output,
        };
      }
      return [...output, ...visibleLines];
    };

    const patchedHandleMouse = function (this: any, event: any) {
      const message = this[originalMessageKey] ?? this.lastMessage;
      if (renderMode !== "clean" || !eligibleThinking(message)) {
        return originalHandleMouse.call(this, event);
      }
      const key = assistantMessageKey(message);
      const member = activityTimeline.memberForThinking(key);
      const group = member ? activityTimeline.groupForMember(member.id) : undefined;
      if (!member || !group) return originalHandleMouse.call(this, event);
      if (group.toolCallIds.length === 0) return originalHandleMouse.call(this, event);
      const position = activityMemberPosition(group, member);
      const isLeftClick = event.type === "click" && event.button === "left";

      // A completed assistant message can contain both the final Thought and
      // visible Markdown. The Markdown is rendered after the activity rows;
      // route clicks in that suffix back to Pi's native component so links,
      // text selection, and code-block Copy controls keep working.
      if (visibleAssistantText(message)) {
        const visibleLines = originalRender.call(this, event.width);
        const renderedLines = patchedRender.call(this, event.width);
        const activityHeight = Math.max(0, renderedLines.length - visibleLines.length);
        if (event.y >= activityHeight) {
          return originalHandleMouse.call(this, {
            ...event,
            y: event.y - activityHeight,
            height: visibleLines.length,
          });
        }
      }

      if (!activityGroupRevealed(group)) {
        if (!isLeftClick) return undefined;
        if (position.first) {
          revealedActivityGroups.add(group.id);
          for (const toolCallId of group.toolCallIds) cleanCompactToolCallIds.add(toolCallId);
          refreshGroup(group);
        }
        return { handled: true };
      }
      const summaryHeight = position.first ? renderActivityGroupSummary(group, event.width).length : 0;
      if (position.first && event.y > 0 && event.y <= summaryHeight && isLeftClick) {
        revealedActivityGroups.delete(group.id);
        for (const toolCallId of group.toolCallIds) {
          cleanCompactToolCallIds.delete(toolCallId);
          const component = cleanToolComponents.get(toolCallId);
          if (component?.expanded) component.setExpanded(false);
        }
        for (const child of group.members) expandedThinkingMembers.delete(child.id);
        refreshGroup(group);
        return { handled: true };
      }
      if (isLeftClick) {
        if (expandedThinkingMembers.has(member.id)) expandedThinkingMembers.delete(member.id);
        else expandedThinkingMembers.add(member.id);
        refreshGroup(group);
        return { handled: true };
      }
      return undefined;
    };

    assistantPrototype[thinkingPatchKey] = {
      originalUpdateContent,
      patchedUpdateContent,
      originalRender,
      patchedRender,
      originalHandleMouse,
      patchedHandleMouse,
    };
    assistantPrototype.updateContent = patchedUpdateContent;
    assistantPrototype.render = patchedRender;
    assistantPrototype.handleMouse = patchedHandleMouse;

    pi.on("session_shutdown", () => {
      const patch = assistantPrototype[thinkingPatchKey];
      if (!patch) return;
      if (patch.patchedUpdateContent === assistantPrototype.updateContent) {
        assistantPrototype.updateContent = patch.originalUpdateContent;
      }
      if (patch.patchedRender === assistantPrototype.render) {
        assistantPrototype.render = patch.originalRender;
      }
      if (patch.patchedHandleMouse === assistantPrototype.handleMouse) {
        assistantPrototype.handleMouse = patch.originalHandleMouse;
      }
      if (
        assistantPrototype.updateContent === patch.originalUpdateContent &&
        assistantPrototype.render === patch.originalRender &&
        assistantPrototype.handleMouse === patch.originalHandleMouse
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

  const indexDisplayedCustomUpdateHints = (entries: any[]) => {
    customUpdateToolHints.clear();
    customUpdateBeforeToolHints.clear();
    let lastToolCallId: string | undefined;
    let pendingCustomKeys: string[] = [];
    for (const entry of entries) {
      if (entry?.type === "compaction") {
        lastToolCallId = undefined;
        pendingCustomKeys = [];
        continue;
      }
      if (entry?.type === "custom_message") {
        if (entry.display !== false) {
          const key = customMessageKey(entry);
          if (lastToolCallId) customUpdateToolHints.set(key, lastToolCallId);
          else pendingCustomKeys.push(key);
        }
        continue;
      }
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role === "user") {
        lastToolCallId = undefined;
        pendingCustomKeys = [];
        continue;
      }
      if (message?.role === "assistant") {
        const toolCalls = (Array.isArray(message.content) ? message.content : [])
          .filter((item: any) => item?.type === "toolCall" && item.id);
        if (toolCalls.length > 0 && pendingCustomKeys.length > 0) {
          for (const key of pendingCustomKeys) {
            customUpdateToolHints.set(key, toolCalls[0].id);
            customUpdateBeforeToolHints.add(key);
          }
          pendingCustomKeys = [];
        }
        if (visibleAssistantText(message) || assistantSystemBoundary(message)) {
          lastToolCallId = undefined;
          pendingCustomKeys = [];
        }
        for (const item of toolCalls) lastToolCallId = item.id;
        continue;
      }
      if (message?.role === "toolResult" && message.toolCallId) {
        lastToolCallId = message.toolCallId;
      }
    }
  };

  const interactiveModePrototype = InteractiveMode.prototype as any;
  const toolsExpansionPatchKey = Symbol.for("pretty-tui.clean-tool-expansion");
  if (!interactiveModePrototype[toolsExpansionPatchKey]) {
    const originalSetToolsExpanded = interactiveModePrototype.setToolsExpanded;
    const originalRenderSessionEntries = interactiveModePrototype.renderSessionEntries;
    const originalSwitchTuiMode = interactiveModePrototype.switchTuiMode;
    const originalShowExtensionNotify = interactiveModePrototype.showExtensionNotify;
    const patchedSetToolsExpanded = function (this: any, expanded: boolean) {
      cleanToolsExpanded = expanded;
      changingAllToolsExpansion = true;
      if (!expanded) {
        cleanCompactToolCallIds.clear();
        revealedActivityGroups.clear();
        expandedThinkingMembers.clear();
      }
      try {
        return originalSetToolsExpanded.call(this, expanded);
      } finally {
        changingAllToolsExpansion = false;
        for (const component of thinkingComponents.values()) component.invalidate?.();
        this.ui?.requestRender?.();
      }
    };

    const patchedRenderSessionEntries = function (this: any, entries: any[], options?: any) {
      currentTui = this.ui;
      fullscreenTui = currentTui?.mode === "fullscreen";
      // buildContextEntries() prepends the latest compaction for model context,
      // while Pi's live compaction UI appends it chronologically. Keep reloads
      // and transcript rebuilds consistent with that live presentation.
      const orderedEntries = orderContextEntriesForTranscript(entries);
      indexDisplayedCustomUpdateHints(orderedEntries);
      return originalRenderSessionEntries.call(this, orderedEntries, options);
    };

    const patchedSwitchTuiMode = function (this: any, ...args: any[]) {
      const result = originalSwitchTuiMode.apply(this, args);
      currentTui = this.ui;
      fullscreenTui = currentTui?.mode === "fullscreen";
      return result;
    };

    const patchedShowExtensionNotify = function (
      this: any,
      message: string,
      type?: "info" | "warning" | "error",
    ) {
      if (renderMode !== "clean" || (type !== undefined && type !== "info")) {
        return originalShowExtensionNotify.call(this, message, type);
      }
      const [firstLine, ...remainingLines] = String(message).split("\n");
      const updateKey = `info:${++activityUpdateSequence}`;
      const title = firstLine || "Info";
      const content = remainingLines.join("\n");
      const member = activityTimeline.addUpdate(updateKey, title, content, false) ??
        activityTimeline.addPendingUpdate(updateKey, title, content, false);
      const group = activityTimeline.groupForMember(member.id);
      if (!group || !this.chatContainer?.addChild) {
        return originalShowExtensionNotify.call(this, message, type);
      }
      const component: Component = {
        render: (width: number) => {
          if (group.toolCallIds.length === 0) return renderPendingActivityUpdate(member, width);
          const position = activityMemberPosition(group, member);
          if (!activityGroupRevealed(group)) {
            return position.first
              ? ["", ...renderActivityGroupSummary(group, width, true)]
              : [];
          }
          return renderActivityUpdate(group, member, width);
        },
        invalidate() {},
        handleMouse: (event: any) => handleActivityUpdateMouse(group, member, event),
      } as Component;
      activityUpdateComponents.set(member.id, component);
      this.chatContainer.addChild(component);
      this.ui?.requestRender?.();
    };

    interactiveModePrototype[toolsExpansionPatchKey] = {
      originalSetToolsExpanded,
      patchedSetToolsExpanded,
      originalRenderSessionEntries,
      patchedRenderSessionEntries,
      originalSwitchTuiMode,
      patchedSwitchTuiMode,
      originalShowExtensionNotify,
      patchedShowExtensionNotify,
    };
    interactiveModePrototype.setToolsExpanded = patchedSetToolsExpanded;
    interactiveModePrototype.renderSessionEntries = patchedRenderSessionEntries;
    interactiveModePrototype.switchTuiMode = patchedSwitchTuiMode;
    interactiveModePrototype.showExtensionNotify = patchedShowExtensionNotify;

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
      if (patch.patchedShowExtensionNotify === interactiveModePrototype.showExtensionNotify) {
        interactiveModePrototype.showExtensionNotify = patch.originalShowExtensionNotify;
      }
      if (
        interactiveModePrototype.setToolsExpanded === patch.originalSetToolsExpanded &&
        interactiveModePrototype.renderSessionEntries === patch.originalRenderSessionEntries &&
        interactiveModePrototype.switchTuiMode === patch.originalSwitchTuiMode &&
        interactiveModePrototype.showExtensionNotify === patch.originalShowExtensionNotify
      ) {
        delete interactiveModePrototype[toolsExpansionPatchKey];
      }
    });
  }

  // Fullscreen selection only emits a component click when press and release
  // land on the exact same cell. Give clean group rows a tiny horizontal
  // tolerance so an ordinary click does not turn into an accidental selection.
  const altScreenPrototype = TuiAltScreen.prototype as any;
  const cleanSummaryClickPatchKey = Symbol.for("pretty-tui.clean-summary-click");
  const cleanSummaryPressKey = Symbol("pretty-tui.clean-summary-press");
  if (!altScreenPrototype[cleanSummaryClickPatchKey]) {
    const originalHandleSelectionMouseEvent = altScreenPrototype.handleSelectionMouseEvent;
    const summaryAtPoint = (screen: any, x: number, y: number): boolean => {
      const line = stripTerminalSequences(screen.previousScreen?.[y] ?? "");
      const match = /●\s+(?:Done|Running)\([^)]*\)/.exec(line);
      return Boolean(match && x >= match.index && x < match.index + match[0].length);
    };
    const patchedHandleSelectionMouseEvent = function (this: any, event: any) {
      const isMotion = (event.button & 32) !== 0;
      const isLeftPress = !event.release && !isMotion && (event.button & 3) === 0;
      if (isLeftPress) {
        if (summaryAtPoint(this, event.x, event.y)) {
          this[cleanSummaryPressKey] = { x: event.x, y: event.y };
        } else {
          delete this[cleanSummaryPressKey];
        }
        return originalHandleSelectionMouseEvent.call(this, event);
      }

      const press = this[cleanSummaryPressKey];
      if (press) {
        const withinClickTolerance =
          event.y === press.y && Math.abs(event.x - press.x) <= 2;
        if (isMotion && withinClickTolerance) {
          return;
        }
        if (event.release) {
          delete this[cleanSummaryPressKey];
          if (withinClickTolerance) {
            return originalHandleSelectionMouseEvent.call(this, { ...event, x: press.x });
          }
        } else if (isMotion) {
          delete this[cleanSummaryPressKey];
        }
      }
      return originalHandleSelectionMouseEvent.call(this, event);
    };

    altScreenPrototype[cleanSummaryClickPatchKey] = {
      originalHandleSelectionMouseEvent,
      patchedHandleSelectionMouseEvent,
    };
    altScreenPrototype.handleSelectionMouseEvent = patchedHandleSelectionMouseEvent;

    pi.on("session_shutdown", () => {
      const patch = altScreenPrototype[cleanSummaryClickPatchKey];
      if (patch?.patchedHandleSelectionMouseEvent === altScreenPrototype.handleSelectionMouseEvent) {
        altScreenPrototype.handleSelectionMouseEvent = patch.originalHandleSelectionMouseEvent;
      }
      if (
        patch &&
        altScreenPrototype.handleSelectionMouseEvent === patch.originalHandleSelectionMouseEvent
      ) {
        delete altScreenPrototype[cleanSummaryClickPatchKey];
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
      if (token?.type === "heading") {
        const level = Math.max(1, Math.min(6, Number(token.depth) || 1));
        const maxWidth = Math.max(1, width);
        const addHeadingSpacing = (lines: string[]) => {
          if (nextTokenType && nextTokenType !== "space") lines.push("");
          return lines;
        };
        const headingStyle = (text: string) => this.theme.heading(text);
        const foregroundLuminance = (styled: string): number | undefined => {
          const trueColor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(styled);
          if (!trueColor) return undefined;
          const [, red, green, blue] = trueColor.map(Number);
          return red * 0.2126 + green * 0.7152 + blue * 0.0722;
        };
        const defaultLuminance = foregroundLuminance(this.applyDefaultStyle("M"));
        const headingLuminance = foregroundLuminance(headingStyle("M"));
        const darkTheme =
          defaultLuminance !== undefined
            ? defaultLuminance >= 128
            : (headingLuminance ?? 255) >= 160;
        const whiteStyle = (text: string) => `\x1b[97m${text}\x1b[39m`;
        const titleStyle =
          level === 1 || level === 3
            ? (text: string) => headingStyle(this.theme.bold(this.theme.underline(text)))
            : level === 2
              ? (text: string) =>
                  (darkTheme ? whiteStyle : headingStyle)(
                    this.theme.bold(this.theme.underline(text)),
                  )
              : level === 4
                ? (text: string) => headingStyle(this.theme.bold(text))
                : level === 5
                  ? headingStyle
                  : (text: string) => this.theme.quote(this.theme.italic(text));
        const titleContext = {
          applyText: titleStyle,
          stylePrefix: this.getStylePrefix(titleStyle),
        };
        const title = this.renderInlineTokens(token.tokens || [], titleContext);

        if (level === 1 && maxWidth >= 6) {
          const maximumInnerWidth = maxWidth - 4;
          const titleLines = wrapTextWithAnsi(title, Math.max(1, maximumInnerWidth));
          const innerWidth = Math.max(
            1,
            ...titleLines.map((line: string) => visibleWidth(line)),
          );
          const frameWidth = Math.min(maxWidth, innerWidth + 4);
          const frameStyle = (text: string) => headingStyle(this.theme.bold(text));
          const lines = [
            frameStyle(`╔${"═".repeat(frameWidth - 2)}╗`),
            ...titleLines.map((line: string) => {
              const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
              return frameStyle("║ ") + line + frameStyle(`${padding} ║`);
            }),
            frameStyle(`╚${"═".repeat(frameWidth - 2)}╝`),
          ];
          return addHeadingSpacing(lines);
        }

        if (level === 2) {
          // Reverse only the rendered title cells: the theme's heading color
          // becomes a compact, content-width background label with no frame.
          const lines = wrapTextWithAnsi(title, maxWidth).map((line: string) =>
            darkTheme
              ? `\x1b[48;5;94m${line}\x1b[49m`
              : `\x1b[107m\x1b[7m${line}\x1b[27m\x1b[49m`
          );
          return addHeadingSpacing(lines);
        }

        if (level === 5 && maxWidth >= 8) {
          const prefix = "┄┄ ";
          const suffix = " ┄┄";
          const contentWidth = Math.max(
            1,
            maxWidth - visibleWidth(prefix) - visibleWidth(suffix),
          );
          const wrapped = wrapTextWithAnsi(title, contentWidth);
          const lines = wrapped.map((line: string, index: number) => {
            const left = index === 0 ? this.theme.heading(prefix) : " ".repeat(visibleWidth(prefix));
            const right = index === wrapped.length - 1 ? this.theme.heading(suffix) : "";
            return left + line + right;
          });
          return addHeadingSpacing(lines);
        }

        return addHeadingSpacing(wrapTextWithAnsi(title, maxWidth));
      }

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

  const foregroundLuminance = (styled: string): number | undefined => {
    const trueColor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(styled);
    if (!trueColor) return undefined;
    const [, red, green, blue] = trueColor.map(Number);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };

  const successMarkerColor = (theme: any): string => {
    const textLuminance = foregroundLuminance(theme.fg("text", "M"));
    return textLuminance !== undefined && textLuminance < 128
      ? "success"
      : "syntaxComment";
  };

  const callRow = (theme: any, name: string, detail: string, state: any): DisplayRow => ({
    prefix: () => {
      const status = (state.compactToolStatus ?? "running") as ToolStatus;
      const color = status === "success" ? successMarkerColor(theme) : status === "error" ? "error" : "dim";
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

  const writeCall = (theme: any, name: string, path: string, content: string, expanded: boolean, state: any) => {
    const lines = content.replace(/\t/g, "    ").split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const total = lines.length;
    const shown = lines.slice(0, expanded ? total : 10);
    const remaining = total - shown.length;
    const rows: DisplayRow[] = [
      callRow(theme, name, `${path} · ${total} ${total === 1 ? "line" : "lines"}`, state),
    ];

    for (let index = 0; index < shown.length; index++) {
      const isLast = index === shown.length - 1 && remaining === 0;
      rows.push({
        prefix: theme.fg("dim", isLast ? "   └ " : "   │ "),
        continuation: isLast ? "     " : theme.fg("dim", "   │ "),
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
      while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const shown = lines.slice(0, 40);
      const omitted = lines.length - shown.length;
      for (let index = 0; index < shown.length; index++) {
        const isLast = index === shown.length - 1 && omitted === 0;
        rows.push({
          prefix: theme.fg("dim", isLast ? "   └ " : "   │ "),
          continuation: isLast ? "     " : theme.fg("dim", "   │ "),
          content: outputStyle(shown[index] || " "),
        });
      }
      if (omitted > 0) {
        rows.push({
          prefix: theme.fg("muted", "   └ "),
          continuation: "     ",
          content: theme.fg("muted", `… ${omitted} more lines`),
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
        continuation: isLast ? "     " : theme.fg("dim", "   │ "),
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
    thoughtCount?: number;
    lastToolCallId: string;
    toolCallIds?: string[];
    activity?: string;
  };
  type ToolSummaryData = {
    count?: number;
    failed?: number;
    thoughtCount?: number;
    /** Identifies the last tool component for older single-group entries. */
    lastToolCallId?: string;
    /** All groups from a run, used to restore summaries after reload. */
    groups?: ToolSummaryGroup[];
  };
  type ToolActivityHold = {
    toolCallId: string;
    name: string;
    until: number;
    after: string;
    started: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  const settledSummaries = new Map<string, {
    count: number;
    failed: number;
    thoughtCount: number;
    activity: DisplayValue;
  }>();
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

  const toolLabel = (toolName: string, label?: string): string => label || toolName;

  const conciseThirdPartyArgs = (args: any): string => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "";
    const sensitive = /(?:token|secret|password|authorization|credential|api[_-]?key)/iu;
    const preferred = ["path", "query", "url", "offset", "id"];
    const entries = Object.entries(args)
      .filter(([key, value]) => !sensitive.test(key) && ["string", "number", "boolean"].includes(typeof value))
      .sort(([left], [right]) => {
        const leftRank = preferred.indexOf(left);
        const rightRank = preferred.indexOf(right);
        return (leftRank < 0 ? preferred.length : leftRank) -
          (rightRank < 0 ? preferred.length : rightRank);
      })
      .slice(0, 2)
      .map(([key, value]) => {
        const safeValue = String(value)
          .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1…:…@")
          .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^&\s]+/giu, "$1…");
        const rendered = truncateToWidth(safeValue, 36, "…");
        return `${key}=${rendered}`;
      });
    return entries.join(" · ");
  };

  const thirdPartyResultSummary = (component: any): string => {
    const detailsError = component.result?.details?.error;
    const firstText = component.result?.content?.find(
      (item: any) => item?.type === "text" && typeof item.text === "string" && item.text.length > 0,
    )?.text;
    const text = String(typeof detailsError === "string" ? detailsError : firstText ?? "");
    const boundedText = text.slice(0, 512);
    const newline = boundedText.indexOf("\n");
    const boundedFirstLine = boundedText.slice(0, newline < 0 ? boundedText.length : newline);
    const firstLine = stripTerminalSequences(boundedFirstLine).trim();
    if (firstLine) return truncateToWidth(firstLine, 72, "…");
    if (component.result) return component.result.isError ? "Failed" : "Done";
    return component.executionStarted ? "Running…" : "Pending";
  };

  const renderThirdPartyCompact = (component: any, width: number, theme: any): string[] => {
    const label = toolLabel(component.toolName, component.toolDefinition?.label);
    const args = conciseThirdPartyArgs(component.args);
    const dotColor = component.result?.isError
      ? "error"
      : component.result && !component.isPartial
        ? successMarkerColor(theme)
        : "accent";
    const title = theme.fg(dotColor, "● ") +
      theme.fg("accent", theme.bold(label)) +
      (args ? theme.fg("muted", `(${args})`) : "");
    const result = thirdPartyResultSummary(component);
    const resultColor = component.result?.isError ? "error" : "muted";
    return [
      truncateToWidth(title, Math.max(1, width), "…"),
      theme.fg(resultColor, truncateToWidth(`  └ ${result}`, Math.max(1, width), "…")),
    ];
  };

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
      after: "thinking",
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
        after: "thinking",
        started: true,
      };
      toolActivityHolds.set(toolCallId, hold);
    }
    hold.name = name;
    hold.started = true;
    hold.after = "thinking";
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

  const thoughtCountForTool = (toolCallId: string | undefined): number =>
    toolCallId ? activityTimeline.groupForTool(toolCallId)?.thoughtCount ?? 0 : 0;

  const currentCleanActivity = (): string => {
    if (cleanRun.activeToolCallId) {
      return cleanRun.activeToolName ?? cleanRun.activity ?? "thinking";
    }
    if (cleanRun.lastCompletedToolCallId) {
      const hold = toolActivityHolds.get(cleanRun.lastCompletedToolCallId);
      if (hold) return heldActivity(hold);
    }
    return cleanRun.activeToolName ?? cleanRun.activity ?? (cleanRun.active ? "thinking" : "done");
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
    const cleanChildRenderCacheKey = Symbol("pretty-tui.clean-child-render-cache");
    const refreshActivityGroup = (group: ActivityGroup) => {
      for (const member of group.members) {
        if (member.kind === "tool" && member.toolCallId) {
          cleanToolComponents.get(member.toolCallId)?.updateDisplay();
        } else if (member.kind === "thinking" && member.messageKey) {
          thinkingComponents.get(member.messageKey)?.invalidate?.();
        }
      }
    };
    const revealCleanGroup = (group: ActivityGroup, ui?: any) => {
      revealedActivityGroups.add(group.id);
      for (const toolCallId of group.toolCallIds) cleanCompactToolCallIds.add(toolCallId);
      refreshActivityGroup(group);
      ui?.requestRender?.();
    };
    const collapseCleanGroup = (group: ActivityGroup, ui?: any) => {
      revealedActivityGroups.delete(group.id);
      for (const toolCallId of group.toolCallIds) {
        const component = cleanToolComponents.get(toolCallId);
        if (component?.expanded) originalSetExpanded.call(component, false);
        cleanCompactToolCallIds.delete(toolCallId);
      }
      for (const member of group.members) expandedThinkingMembers.delete(member.id);
      refreshActivityGroup(group);
      ui?.requestRender?.();
    };
    const patchedMarkExecutionStarted = function (this: any) {
      activityTimeline.addTool(this.toolCallId, this.toolName);
      if (!cleanRun.currentToolCallIds.includes(this.toolCallId)) {
        cleanRun.currentToolCallIds.push(this.toolCallId);
      }
      cleanRun.activeToolCallIds.add(this.toolCallId);
      const displayName = toolLabel(this.toolName, this.toolDefinition?.label);
      cleanToolNames.set(this.toolCallId, displayName);
      setCleanGroupMembers(this.toolCallId, cleanRun.currentToolCallIds.slice());
      if (typeof this.ui?.requestRender === "function") {
        cleanRun.requestRender = () => this.ui.requestRender();
      }
      cleanRun.active = true;
      cleanRun.activeToolCallId = this.toolCallId;
      beginToolActivity(this.toolCallId, displayName, true);
      return originalMarkExecutionStarted.call(this);
    };
    const patchedSetExpanded = function (this: any, expanded: boolean) {
      const group = activityTimeline.groupForTool(this.toolCallId);
      if (
        renderMode === "clean" &&
        !changingAllToolsExpansion &&
        expanded &&
        !this.expanded &&
        group &&
        !activityGroupRevealed(group)
      ) {
        revealCleanGroup(group, this.ui);
        return;
      }
      return originalSetExpanded.call(this, expanded);
    };
    const patchedToolRender = function (this: any, width: number): string[] {
      cleanToolComponents.set(this.toolCallId, this);
      knownToolCallIds.add(this.toolCallId);
      const member = activityTimeline.addTool(this.toolCallId, this.toolName);
      cleanToolNames.set(
        this.toolCallId,
        toolLabel(this.toolName, this.toolDefinition?.label),
      );
      if (this[renderedModeKey] !== renderMode) {
        this[renderedModeKey] = renderMode;
        this.updateDisplay();
      }

      const group = activityTimeline.groupForMember(member.id);
      if (renderMode !== "clean" || !group) return originalToolRender.call(this, width);
      const position = activityMemberPosition(group, member);
      if (!activityGroupRevealed(group)) {
        return position.first
          ? ["", ...renderActivityGroupSummary(group, width, true)]
          : [];
      }

      const childTheme = cleanThemeForToolCall(this.toolCallId) ?? activityGroupTheme(group);
      const {
        prefix: childPrefix,
        continuation,
        childWidth,
      } = activityTreeStyle(group, member, width, childTheme);
      const thirdParty = !SPECIALIZED_TOOL_NAMES.has(this.toolName);
      const cacheable = !this.expanded && Boolean(this.result) && !this.isPartial;
      const cached = cacheable ? this[cleanChildRenderCacheKey] : undefined;
      let decoratedContent: string[];
      if (
        cached?.width === width &&
        cached?.childWidth === childWidth &&
        cached?.result === this.result &&
        cached?.args === this.args &&
        cached?.callRenderer === this.callRendererComponent &&
        cached?.resultRenderer === this.resultRendererComponent &&
        cached?.theme === childTheme &&
        cached?.last === position.last &&
        cached?.memberCount === group.members.length
      ) {
        decoratedContent = cached.lines;
      } else {
        let contentLines: string[];
        if (thirdParty) {
          const summaryLines = renderThirdPartyCompact(this, childWidth, childTheme);
          if (this.expanded) {
            const detailPrefix = "  │ ";
            const nativeLines = originalToolRender.call(
              this,
              Math.max(1, childWidth - visibleWidth(detailPrefix)),
            );
            const nativeContentLines = nativeLines[0] === "" ? nativeLines.slice(1) : nativeLines;
            contentLines = [
              summaryLines[0],
              ...nativeContentLines.map((line: string, index: number) =>
                childTheme.fg(
                  "dim",
                  index === nativeContentLines.length - 1 ? "  └ " : detailPrefix,
                ) + stripAnsiBackgrounds(line)
              ),
            ];
          } else {
            contentLines = summaryLines;
          }
        } else {
          const lines = originalToolRender.call(this, childWidth);
          if (lines.length === 0) return lines;
          contentLines = lines[0] === "" ? lines.slice(1) : lines;
        }
        decoratedContent = contentLines.map((line: string, index: number) =>
          truncateToWidth(
            (index === 0 ? childPrefix : continuation) + line,
            Math.max(1, width),
            "",
          )
        );
        if (cacheable) {
          this[cleanChildRenderCacheKey] = {
            width,
            childWidth,
            result: this.result,
            args: this.args,
            callRenderer: this.callRendererComponent,
            resultRenderer: this.resultRendererComponent,
            theme: childTheme,
            last: position.last,
            memberCount: group.members.length,
            lines: decoratedContent,
          };
        }
      }
      if (!position.first) return decoratedContent;
      return ["", ...renderActivityGroupSummary(group, width), ...decoratedContent];
    };
    const patchedToolHandleMouse = function (this: any, event: any) {
      const member = activityTimeline.memberForTool(this.toolCallId);
      const group = member ? activityTimeline.groupForMember(member.id) : undefined;
      const isLeftClick = event.type === "click" && event.button === "left";
      if (renderMode !== "clean" || !member || !group) {
        return originalToolHandleMouse.call(this, event);
      }
      const position = activityMemberPosition(group, member);
      const revealed = activityGroupRevealed(group);

      if (!revealed && position.first && isLeftClick) {
        revealCleanGroup(group, this.ui);
        return { handled: true };
      }
      if (!revealed) return isLeftClick ? { handled: true } : undefined;

      const summaryHeight = position.first ? renderActivityGroupSummary(group, event.width).length : 0;
      if (position.first && event.y > 0 && event.y <= summaryHeight && isLeftClick) {
        changingAllToolsExpansion = true;
        try {
          collapseCleanGroup(group, this.ui);
        } finally {
          changingAllToolsExpansion = false;
        }
        return { handled: true };
      }

      // Self-rendering tools reserve y=0 for Pi's leading spacer. Clean mode
      // replaces that spacer with the compact header for non-first members.
      const thirdPartyHeaderY = position.first ? summaryHeight + 1 : 0;
      if (
        !SPECIALIZED_TOOL_NAMES.has(this.toolName) &&
        isLeftClick &&
        event.y === thirdPartyHeaderY
      ) {
        originalSetExpanded.call(this, !this.expanded);
        this.ui?.requestRender?.();
        return { handled: true };
      }

      if (!this.result && isLeftClick) {
        originalSetExpanded.call(this, !this.expanded);
        this.ui?.requestRender?.();
        return { handled: true };
      }

      const { prefixWidth } = activityTreeStyle(
        group,
        member,
        event.width,
        cleanThemeForToolCall(this.toolCallId),
      );
      return originalToolHandleMouse.call(this, {
        ...event,
        x: Math.max(0, event.x - prefixWidth),
        y: event.y - summaryHeight + (position.first ? 0 : 1),
        width: Math.max(1, event.width - prefixWidth),
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
        thoughtCount: thoughtCountForTool(cleanRun.lastCompletedToolCallId),
        lastToolCallId: cleanRun.lastCompletedToolCallId,
        toolCallIds: cleanRun.currentToolCallIds.slice(),
        activity,
      };
      cleanRun.groups.push(group);
      settledSummaries.set(group.lastToolCallId, {
        count: group.count,
        failed: group.failed,
        thoughtCount: group.thoughtCount ?? 0,
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
    activityTimeline.boundary();
  };

  const settleLastCleanGroup = () => {
    const group = cleanRun.groups[cleanRun.groups.length - 1];
    if (!group) return;
    group.activity = "done";
    settledSummaries.set(group.lastToolCallId, {
      count: group.count,
      failed: group.failed,
      thoughtCount: group.thoughtCount ?? 0,
      activity: activityValueForHold(group.lastToolCallId, "done"),
    });
  };

  const summaryText = (
    count: number,
    _failed: number,
    thoughtCount: number,
    activity = "done",
  ): string => {
    const rawActivityText = typeof activity === "string" ? activity : "done";
    const normalizedActivityText = rawActivityText.trim();
    const activityText = /^thinking(?:\.\.\.)?$/iu.test(normalizedActivityText)
      ? "thinking"
      : rawActivityText;
    const countLabel = `${count} tool ${count === 1 ? "call" : "calls"}`;
    const thoughtLabel = thoughtCount > 0
      ? ` · ${thoughtCount} ${thoughtCount === 1 ? "thought" : "thoughts"}`
      : "";
    const activityLabel = activityText !== "done" && activityText.trim()
      ? ` · ${activityText}`
      : "";
    return `${countLabel}${thoughtLabel}${activityLabel}`;
  };

  const summaryRow = (
    theme: any,
    count: number,
    failed: number,
    thoughtCount: number,
    activity: DisplayValue = "done",
    collapsedDone = false,
  ): DisplayRow => ({
    prefix: () => {
      const currentActivity = typeof activity === "function" ? activity() : activity;
      const color = currentActivity === "done"
        ? collapsedDone ? "thinkingText" : successMarkerColor(theme)
        : "accent";
      return theme.fg(color, "● ");
    },
    continuation: "  ",
    content: () => {
      const currentActivity = typeof activity === "function" ? activity() : activity;
      const label = currentActivity === "done" ? "Done" : "Running";
      const color = label === "Done"
        ? collapsedDone ? "thinkingText" : successMarkerColor(theme)
        : "accent";
      const detailColor = label === "Done" && collapsedDone ? "thinkingText" : "text";
      return theme.fg(color, theme.bold(label)) +
        theme.fg("dim", "(") +
        theme.fg(detailColor, summaryText(count, failed, thoughtCount, currentActivity)) +
        theme.fg("dim", ")");
    },
  });

  renderCleanGroupSummary = (lastToolCallId: string, width: number): string[] => {
    const summaryTheme = cleanThemeForToolCall(lastToolCallId);
    if (!summaryTheme) return [];
    const settled = settledSummaries.get(lastToolCallId);
    if (settled) {
      return block([summaryRow(
        summaryTheme,
        settled.count,
        settled.failed,
        settled.thoughtCount,
        settled.activity,
      )]).render(width);
    }
    if (cleanRun.activeToolCallId === lastToolCallId) {
      return block([summaryRow(
        summaryTheme,
        liveCleanToolCount(),
        cleanRun.failed,
        thoughtCountForTool(lastToolCallId),
        () => cleanRun.activeToolName ?? currentCleanActivity(),
      )]).render(width);
    }
    if (cleanRun.lastCompletedToolCallId === lastToolCallId && cleanRun.count > 0) {
      return block([summaryRow(
        summaryTheme,
        cleanRun.count,
        cleanRun.failed,
        thoughtCountForTool(lastToolCallId),
        currentCleanActivity,
      )]).render(width);
    }
    return [];
  };

  const renderActivityGroupSummary = (
    group: ActivityGroup,
    width: number,
    collapsedDone = false,
  ): string[] => {
    const fit = (lines: string[]) => lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
    const summaryTheme = activityGroupTheme(group);
    const owner = activityGroupOwner(group);
    if (!summaryTheme || !owner || group.toolCallIds.length === 0) return [];
    const settled = settledSummaries.get(owner);
    if (settled) {
      return fit(block([summaryRow(
        summaryTheme,
        Math.max(settled.count, group.toolCallIds.length),
        settled.failed,
        Math.max(settled.thoughtCount, group.thoughtCount),
        settled.activity,
        collapsedDone,
      )]).render(width));
    }
    const currentBelongs = cleanRun.activeToolCallId
      ? group.toolCallIds.includes(cleanRun.activeToolCallId)
      : false;
    const lastBelongs = cleanRun.lastCompletedToolCallId
      ? group.toolCallIds.includes(cleanRun.lastCompletedToolCallId)
      : false;
    if (currentBelongs || lastBelongs || !cleanRun.settled) {
      return fit(block([summaryRow(
        summaryTheme,
        Math.max(group.toolCallIds.length, liveCleanToolCount()),
        cleanRun.failed,
        group.thoughtCount,
        () => cleanRun.activeToolName ?? currentCleanActivity(),
        collapsedDone,
      )]).render(width));
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
    const activityGroup = activityTimeline.groupForTool(toolCallId);
    if (activityGroup) activityFallbackThemes.set(activityGroup.id, theme);
    return {
      render(width: number): string[] {
        if (renderMode !== "clean") return [];

        const settledSummary = settledSummaries.get(toolCallId);
        if (settledSummary) {
          return block([summaryRow(
            theme,
            settledSummary.count,
            settledSummary.failed,
            settledSummary.thoughtCount,
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
            thoughtCountForTool(toolCallId),
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
          return block([summaryRow(
            theme,
            cleanRun.count,
            cleanRun.failed,
            thoughtCountForTool(toolCallId),
            currentCleanActivity,
          )]).render(width);
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

  // Built-ins use specialized compact renderers, while the activity timeline
  // controls grouping for every tool, including third-party definitions.
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
              thoughtCount: data.thoughtCount ?? 0,
              lastToolCallId: data.lastToolCallId,
            }]
          : (() => {
              const summaryCallId = legacySummaryLastToolCallIds.get(entry.id);
              return summaryCallId
                ? [{
                    count: data?.count ?? 0,
                    failed: data?.failed ?? 0,
                    thoughtCount: data?.thoughtCount ?? 0,
                    lastToolCallId: summaryCallId,
                  }]
                : [];
            })();
      // The live tool components own the visual positions. Keep this durable
      // entry as a fallback only for groups whose components are unexpectedly
      // absent from an uncompacted branch.
      const missingGroups = groups.filter((group) => !knownToolCallIds.has(group.lastToolCallId));
      if (missingGroups.length === 0) return [];
      // Persisted entries represent settled groups, so always normalize their
      // display to Done even when an older entry stored a transient activity.
      return block(missingGroups.map((group) =>
        summaryRow(theme, group.count, group.failed, group.thoughtCount ?? 0, "done", true)
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
    activityTimeline.clear();
    revealedActivityGroups.clear();
    expandedThinkingMembers.clear();
    thinkingComponents.clear();
    activityFallbackThemes.clear();
    activityUpdateComponents.clear();
    customUpdateToolHints.clear();
    customUpdateBeforeToolHints.clear();
    activityUpdateSequence = 0;
    assistantBoundaryKeys.clear();
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
      const thoughtCount = Math.max(
        group.thoughtCount ?? 0,
        thoughtCountForTool(group.lastToolCallId),
      );
      group.thoughtCount = thoughtCount;
      settledSummaries.set(group.lastToolCallId, {
        count: group.count,
        failed: group.failed,
        thoughtCount,
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
        lastFinishedGroup = {
          count,
          failed,
          thoughtCount: thoughtCountForTool(lastToolCallId),
          lastToolCallId,
          toolCallIds: [...toolCalls],
        };
        inferredGroups.push(lastFinishedGroup);
        setCleanGroupMembers(lastToolCallId, [...toolCalls]);
        if (!explicitSummaryIds.has(lastToolCallId)) {
          settledSummaries.set(lastToolCallId, {
            count,
            failed,
            thoughtCount: lastFinishedGroup.thoughtCount ?? 0,
            activity: "done",
          });
        }
      }
      count = 0;
      failed = 0;
      lastToolCallId = undefined;
      toolCalls.clear();
      completedToolCalls.clear();
      activityTimeline.boundary();
    };

    const inferredGroupsOverlapping = (group: ToolSummaryGroup): ToolSummaryGroup[] => {
      if (!group.toolCallIds?.length) return [];
      const persistedIds = new Set(group.toolCallIds);
      const currentGroup = lastToolCallId && count > 0
        ? [{
            count,
            failed,
            thoughtCount: thoughtCountForTool(lastToolCallId),
            lastToolCallId,
            toolCallIds: [...toolCalls],
          }]
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
            thoughtCount: data.thoughtCount ?? 0,
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
            thoughtCount: data?.thoughtCount ?? lastFinishedGroup.thoughtCount ?? 0,
            lastToolCallId: lastFinishedGroup.lastToolCallId,
          }, entry.id);
        } else if (lastToolCallId && count > 0) {
          // Also handle a legacy entry inserted before the boundary text.
          rememberGroup({
            count: data?.count ?? count,
            failed: data?.failed ?? failed,
            thoughtCount: data?.thoughtCount ?? thoughtCountForTool(lastToolCallId),
            lastToolCallId,
          }, entry.id);
        }
        activityTimeline.boundary();
        continue;
      }

      if (entry.type === "custom_message") {
        if (entry.display !== false) addPersistentActivityUpdate(entry);
        continue;
      }

      if (entry.type !== "message") continue;
      const message = entry.message as any;

      if (message.role === "user") {
        finishGroup();
        lastFinishedGroup = undefined;
        continue;
      }

      if (message.role === "custom") {
        if (message.display !== false) addPersistentActivityUpdate(message);
        continue;
      }

      if (message.role === "assistant") {
        const thinking = thinkingText(message);
        if (thinking && !assistantSystemBoundary(message)) {
          activityTimeline.addThinking(assistantMessageKey(message), thinking);
        }
        if (messageHasVisibleText(message)) finishGroup();
        for (const item of messageContentItems(message)) {
          if (item.type !== "toolCall" || !item.id) continue;
          toolCalls.add(item.id);
          activityTimeline.addTool(item.id, item.name ?? "tool");
        }
        if (assistantSystemBoundary(message)) finishGroup();
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
  pi.on("session_before_compact", () => {
    // Pi emits this for manual, threshold, and overflow-recovery compaction.
    // Seal the activity group before the compaction indicator is rendered so
    // completed work never remains labelled Running(... · thinking). A
    // lifecycle boundary overrides the minimum per-tool activity hold.
    clearToolActivityHolds();
    finishCleanGroup("done");
    settleLastCleanGroup();
    cleanRun.activity = "done";
    cleanRun.requestRender?.();
  });
  pi.on("session_compact", () => {
    // Compaction is a hard chronological boundary. Keep tools completed before
    // it in their own group so expanded hierarchy lines never cross the summary.
    finishCleanGroup("done");
    settleLastCleanGroup();
    // Pre-compaction tools have been summarized intentionally. Their durable
    // fallback rows should not be replayed beside the compacted transcript.
    cleanContextCompacted = true;
    cleanRun.requestRender?.();
  });
  pi.on("session_compact_failed", () => {
    // The pre-compaction work is still complete even when compaction is
    // cancelled or fails. Keep it settled and let a retry start a new group.
    settleLastCleanGroup();
    cleanRun.activity = "done";
    cleanRun.requestRender?.();
  });

  const hasVisibleAssistantText = (message: any): boolean =>
    message?.role === "assistant" && messageHasVisibleText(message);

  const closeAtAssistantBoundary = (message: any, activity: string): boolean => {
    const key = assistantMessageKey(message);
    if (assistantBoundaryKeys.has(key)) return false;
    assistantBoundaryKeys.add(key);
    cleanRun.activity = activity;
    finishCleanGroup(activity);
    return true;
  };

  const pendingToolCalls = (message: any): any[] =>
    messageContentItems(message).filter(
      (item: any) => item.type === "toolCall" && item.id,
    );

  const trackThinkingActivity = (message: any): void => {
    if (message?.role !== "assistant" || assistantSystemBoundary(message)) return;
    const thinking = thinkingText(message);
    if (thinking) activityTimeline.addThinking(assistantMessageKey(message), thinking);
  };

  const trackPendingToolActivity = (message: any): boolean => {
    const toolCalls = pendingToolCalls(message);
    if (toolCalls.length === 0) return false;
    for (const toolCall of toolCalls) {
      activityTimeline.addTool(toolCall.id, toolCall.name ?? "tool");
      if (!cleanRun.currentToolCallIds.includes(toolCall.id)) {
        cleanRun.currentToolCallIds.push(toolCall.id);
      }
      cleanToolNames.set(toolCall.id, cleanToolNames.get(toolCall.id) ?? toolCall.name);
    }
    const toolCall = toolCalls[toolCalls.length - 1];
    if (cleanRun.lastCompletedToolCallId === toolCall.id) return false;
    setCleanGroupMembers(toolCall.id, cleanRun.currentToolCallIds.slice());
    cleanRun.active = true;
    cleanRun.activeToolCallId = toolCall.id;
    beginToolActivity(toolCall.id, cleanToolNames.get(toolCall.id) ?? toolCall.name);
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
    if (event.message.role === "custom" && event.message.display !== false) {
      addPersistentActivityUpdate(event.message);
      return;
    }
    if (event.message.role !== "user") return;
    finishCleanGroup("done");
    settleLastCleanGroup();
  });

  // A visible assistant response is the boundary between tool groups. Seal
  // the prior group directly as Done; the response text already communicates
  // current activity and does not need a duplicate response status.
  pi.on("message_update", (event) => {
    if (hasVisibleAssistantText(event.message)) {
      trackThinkingActivity(event.message);
      clearToolActivityHolds();
      closeAtAssistantBoundary(event.message, "done");
      return;
    }
    if (assistantSystemBoundary(event.message)) {
      closeAtAssistantBoundary(event.message, "done");
      settleLastCleanGroup();
      return;
    }
    trackThinkingActivity(event.message);
    trackPendingToolActivity(event.message);
  });
  pi.on("message_end", (event) => {
    if (hasVisibleAssistantText(event.message) || assistantSystemBoundary(event.message)) {
      trackThinkingActivity(event.message);
      closeAtAssistantBoundary(event.message, "done");
      cleanRun.activity = "done";
      settleLastCleanGroup();
      return;
    }
    trackThinkingActivity(event.message);
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
    cleanRun.activity = "thinking";
  });
  pi.on("tool_execution_start", (event) => {
    activityTimeline.addTool(event.toolCallId, event.toolName);
    if (!cleanRun.currentToolCallIds.includes(event.toolCallId)) {
      cleanRun.currentToolCallIds.push(event.toolCallId);
    }
    cleanRun.activeToolCallIds.add(event.toolCallId);
    const displayName = cleanToolNames.get(event.toolCallId) ?? event.toolName;
    cleanToolNames.set(event.toolCallId, displayName);
    setCleanGroupMembers(event.toolCallId, cleanRun.currentToolCallIds.slice());
    cleanRun.active = true;
    cleanRun.activeToolCallId = event.toolCallId;
    beginToolActivity(event.toolCallId, displayName, true);
  });
  pi.on("tool_execution_end", (event) => {
    const activityName = cleanRun.activeToolCallId === event.toolCallId
      ? cleanRun.activeToolName ?? cleanToolNames.get(event.toolCallId) ?? event.toolName
      : cleanToolNames.get(event.toolCallId) ?? event.toolName;
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
      cleanRun.activity = cleanRun.activeToolName ?? "thinking";
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
    cleanRun.activity = "thinking";
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
        thoughtCount: group.thoughtCount ?? 0,
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
    const thoughtCount = groups.reduce((total, group) => total + (group.thoughtCount ?? 0), 0);
    const lastToolCallId = groups[groups.length - 1]?.lastToolCallId;
    pi.appendEntry<ToolSummaryData>("pretty-tui-tool-summary", {
      count,
      failed,
      thoughtCount,
      lastToolCallId,
      groups: groups.map(({ count, failed, thoughtCount, lastToolCallId, toolCallIds }) => ({
        count,
        failed,
        thoughtCount,
        lastToolCallId,
        toolCallIds,
      })),
    });
  });

  const read = createReadTool(cwd);
  const readLabel = read.label || read.name;
  pi.registerTool({
    ...read,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, readLabel, context.toolCallId);
      const range = args.offset || args.limit
        ? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`
        : "";
      return call(theme, readLabel, `${args.path}${range}`, context.state);
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
  const bashLabel = bash.label || bash.name;
  pi.registerTool({
    ...bash,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, bashLabel, context.toolCallId);
      const command = typeof args.command === "string" ? args.command : "";
      if (useCompactToolView(context.toolCallId, context.expanded)) {
        const commandLines = command.split(/\r\n|\r|\n/);
        const firstLine = commandLines[0] ?? "";
        const omitted = commandLines.length - 1;
        const detail = omitted > 0
          ? `${firstLine} … (${omitted} more ${omitted === 1 ? "line" : "lines"})`
          : firstLine;
        return call(theme, bashLabel, detail, context.state);
      }
      return call(theme, bashLabel, command, context.state);
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
  const editLabel = edit.label || edit.name;
  pi.registerTool({
    ...edit,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, editLabel, context.toolCallId);
      const count = Array.isArray(args.edits) ? ` · ${args.edits.length} changes` : "";
      return call(theme, editLabel, `${args.path}${count}`, context.state);
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
  const writeLabel = write.label || write.name;
  pi.registerTool({
    ...write,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, writeLabel, context.toolCallId);
      const content = typeof args.content === "string" ? args.content : "";
      const path = String(args.path ?? "");
      if (useCompactToolView(context.toolCallId, context.expanded)) {
        const lines = content.replace(/\t/g, "    ").split("\n");
        while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const total = lines.length;
        return call(theme, writeLabel, `${path} · ${total} ${total === 1 ? "line" : "lines"}`, context.state);
      }
      return writeCall(theme, writeLabel, path, content, context.expanded, context.state);
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
  const grepLabel = grep.label || grep.name;
  pi.registerTool({
    ...grep,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, grepLabel, context.toolCallId);
      const where = args.path ? ` · ${args.path}` : "";
      const glob = args.glob ? ` · ${args.glob}` : "";
      return call(theme, grepLabel, `${args.pattern}${where}${glob}`, context.state);
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
  const findLabel = find.label || find.name;
  pi.registerTool({
    ...find,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, findLabel, context.toolCallId);
      return call(theme, findLabel, `${args.pattern}${args.path ? ` · ${args.path}` : ""}`, context.state);
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
  const lsLabel = ls.label || ls.name;
  pi.registerTool({
    ...ls,
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      if (hideCleanTool(context.toolCallId, context.expanded, context.executionStarted)) return cleanToolCall(theme, lsLabel, context.toolCallId);
      return call(theme, lsLabel, args.path ?? ".", context.state);
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

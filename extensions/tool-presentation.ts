import { highlightNativeShellCall } from "./shell-highlight.js";
import { isNativeImageRow, stripAnsiBackgrounds } from "./ansi-style.js";
import { cardMargin, frameNativeRows, frameNativeToolRows, nativeFrameWidth } from "./full-frame.js";
import { Spacer, Text, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NestedTools } from "./nested-tools.js";

// Tool content and hit regions are independent of activity grouping. The host
// decides whether to decorate this projection with a clean activity tree.
export const SPECIALIZED_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
// A third-party renderer can also use renderShell: "self". The shell style is
// not proof that it is one of our specialized built-in renderers.
export const THIRD_PARTY_TOOL = Symbol("pretty-tui.third-party-tool");
export const isThirdPartyTool = (owner: any): boolean =>
  Boolean(owner.toolDefinition?.[THIRD_PARTY_TOOL]) ||
  !SPECIALIZED_TOOL_NAMES.has(owner.toolName) || owner.toolDefinition?.renderShell !== "self";

export const toolLabel = (toolName: string, label?: string): string => label || toolName;

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

export const renderThirdPartyCompact = (component: any, width: number, theme: any): string[] => {
  const label = toolLabel(component.toolName, component.toolDefinition?.label);
  const args = conciseThirdPartyArgs(component.args);
  const dotColor = component.result?.isError
    ? "error"
    : component.result && !component.isPartial
      ? "success"
      : "dim";
  const title = theme.fg(dotColor, "● ") +
    theme.fg("text", theme.bold(label)) +
    (args ? theme.fg("muted", `(${args})`) : "");
  const result = thirdPartyResultSummary(component);
  const resultColor = component.result?.isError ? "error" : "muted";
  return [
    truncateToWidth(title, Math.max(1, width), "…"),
    theme.fg(resultColor, truncateToWidth(`  └ ${result}`, Math.max(1, width), "…")),
  ];
};

export type ToolProjection = {
  lines: string[];
  actions: Map<number, string>;
  toggleRows: Set<number>;
  // Coordinates of the original renderer inside the projection. sourceY
  // accounts for Pi's spacer, removed only by compact/clean presentation.
  native?: { x: number; y: number; width: number; height: number; sourceY: number };
  sourceRows?: Map<number, number>;
};

// Native shell/codemode timers are distinct final renderer components. Locate
// that component, never a matching line in user output, before moving it.
const nativeTimerRegion = (owner: any, resultStart: number, contentWidth: number, width: number, rows: string[]) => {
  if (!["bash", "powershell", "codemode"].includes(owner.toolName)) return undefined;
  const state = owner.rendererState?.nativeFull?.state ?? owner.rendererState;
  if (typeof state?.startedAt !== "number" && typeof state?.endedAt !== "number") return undefined;
  const children: any[] | undefined = owner.resultRendererComponent?.children;
  if (!children?.length) return undefined;
  const tail = children[children.length - 1];
  if (!(tail instanceof Text) || typeof (tail as any).text !== "string") return undefined;
  const label = stripTerminalSequences((tail as any).text).trim();
  if (!/^(?:Took|Elapsed) \d+(?:\.\d+)?[smh](?: \d+(?:\.\d+)?[smh])*$/.test(label) || visibleWidth(label) + 6 > width) return undefined;
  let first = children.length - 1;
  if (children[first - 1] instanceof Spacer) first--;
  const height = (items: any[]) => items.reduce((sum, item) => sum + item.render(contentWidth).length, 0);
  const start = resultStart + height(children.slice(0, first));
  const end = resultStart + height(children);
  if (rows.slice(start, end).map(stripTerminalSequences).join("\n").trim() !== label) return undefined;
  return { label, start, end };
};

function renderToolContent(
  owner: any,
  width: number,
  theme: any,
  options: {
    mode: "full" | "compact";
    nested: NestedTools;
    nestedExpanded: boolean;
    panels?: boolean;
    cardTitle?: string;
    renderNative: (width: number) => string[];
  },
): ToolProjection | undefined {
  const actions = new Map<number, string>();
  const toggleRows = new Set<number>();
  if (options.mode === "full") {
    const innerWidth = nativeFrameWidth(width);
    highlightNativeShellCall(owner, theme);
    const nativeLines = options.renderNative(innerWidth);
    if (!nativeLines.length) return { lines: [], actions, toggleRows };
    const self = owner.toolDefinition?.renderShell === "self";
    const shell = self ? owner.selfRenderContainer : owner.contentBox;
    const call = shell?.children?.[0];
    const callWidth = self ? innerWidth : Math.max(1, innerWidth - (owner.outputPad ?? 1) * 2);
    const callStart = self ? 1 : 2;
    const callHeight = call?.render(callWidth).length ?? 0;
    const resultBoundaries: number[] = [];
    if (!owner.toolDefinition && typeof owner.formatToolExecution === "function") {
      // Unknown historical tools use Pi's generic Text component. Measure the
      // native prefix rather than reconstructing or parsing the displayed args.
      const output = owner.getTextOutput();
      const formatted = owner.formatToolExecution();
      if (output && formatted.endsWith("\n" + output)) {
        const prefix = formatted.slice(0, -output.length - 1);
        const resultY = new Text(prefix, owner.outputPad ?? 1, 1).render(innerWidth).length;
        resultBoundaries.push(resultY);
      } else if (owner.imageComponents?.length && owner.contentText) {
        // With image display enabled, the generic text output may be empty;
        // the native image spacers and payload follow the generic text region.
        resultBoundaries.push(1 + owner.contentText.render(innerWidth).length);
      }
    }
    // Native edit puts its authoritative diff in the call component so a
    // pre-execution preview can update in place. Split the displayed rows at
    // that region without rebuilding or duplicating its content.
    const preview = owner.callRendererComponent;
    if ((typeof preview?.preview?.diff === "string" || typeof preview?.preview?.error === "string") && preview.children?.length >= 3) {
      const previewWidth = Math.max(1, callWidth - (preview.paddingX ?? 0) * 2);
      const diffStart = callStart + (preview.paddingY ?? 0) +
        preview.children.slice(0, 2).reduce((sum: number, child: any) => sum + child.render(previewWidth).length, 0);
      resultBoundaries.push(diffStart);
    }
    if (owner.result && shell?.children?.length > 1) {
      const resultStart = callStart + callHeight;
      if (resultStart < nativeLines.length) resultBoundaries.push(resultStart);
    }
    // Only split a real result. Native edit previews before execution stay in
    // the call card; empty/collapsed results must not create an empty card.
    const timer = nativeTimerRegion(owner, callStart + callHeight, callWidth, width - cardMargin(width) * 2, nativeLines);
    const sourceIndexes = nativeLines.map((_, y) => y).filter((y) => !timer || y < timer.start || y >= timer.end);
    const displayed = sourceIndexes.map((y) => nativeLines[y]);
    const candidates = owner.result ? resultBoundaries.sort((a, b) => a - b)
      .map((start) => sourceIndexes.findIndex((y) => y >= start)) : [];
    const resultStart = candidates.find((start) => start > 0 && start < displayed.length &&
      displayed.slice(start).some((line) => stripTerminalSequences(line).trim() ||
        line.includes("\x1b_G") || line.includes("\x1b]1337;File=")));
    const frame = frameNativeToolRows(
      options.cardTitle ?? toolLabel(owner.toolName, owner.toolDefinition?.label), displayed, width, theme,
      resultStart, owner.result?.isError ? "error" : owner.isPartial ? "muted" : "success", owner, timer?.label,
    );
    const sourceRows = new Map([...frame.sourceRows].map(([y, original]) => [y, sourceIndexes[original]]));
    if (timer) sourceRows.set(frame.lines.length - 1, timer.start);
    return {
      lines: frame.lines, actions, toggleRows, sourceRows,
      native: { x: frame.inset, y: 0, width: innerWidth, height: nativeLines.length, sourceY: 0 },
    };
  }
  if (options.nested.count(owner.toolCallId) > 0) {
    return { ...options.nested.render({ ...owner, expanded: options.nestedExpanded }, width, theme), toggleRows };
  }
  if (!isThirdPartyTool(owner)) return undefined;
  const summary = renderThirdPartyCompact(owner, width, theme);
  toggleRows.add(0);
  if (!owner.expanded) {
    toggleRows.add(1);
    return { lines: summary, actions, toggleRows };
  }
  const prefix = "  │ ";
  const nativeWidth = Math.max(1, width - visibleWidth(prefix));
  const nativeLines = options.renderNative(nativeWidth);
  const sourceY = nativeLines[0] === "" ? 1 : 0;
  const content = nativeLines.slice(sourceY);
  return {
    lines: [summary[0], ...content.map((line, i) => isNativeImageRow(line) ? line :
      truncateToWidth(
        theme.fg("dim", i === content.length - 1 ? "  └ " : prefix) + stripAnsiBackgrounds(line),
        Math.max(1, width), "",
      ))],
    actions, toggleRows,
    native: { x: visibleWidth(prefix), y: 1, width: nativeWidth, height: content.length, sourceY },
  };
}

/** Compact shares panel geometry with full, retaining its concise projection. */
export function renderToolProjection(
  owner: any, width: number, theme: any,
  options: Parameters<typeof renderToolContent>[3],
): ToolProjection | undefined {
  if (options.mode === "full" || options.panels === false) return renderToolContent(owner, width, theme, options);
  if (owner.expanded && !options.nested.count(owner.toolCallId)) {
    const projection = renderToolContent(owner, width, theme, { ...options, mode: "full", cardTitle: `${toolLabel(owner.toolName, owner.toolDefinition?.label)} ▾` });
    if (projection) {
      projection.toggleRows.add(0);
      if (width < 8) projection.lines = projection.lines.map((line) => isNativeImageRow(line) ? line : truncateToWidth(line, Math.max(1, width), ""));
    }
    return projection;
  }
  const innerWidth = nativeFrameWidth(width);
  let content = renderToolContent(owner, innerWidth, theme, options);
  if (!content) {
    const raw = options.renderNative(innerWidth);
    if (!raw.length) return { lines: [], actions: new Map(), toggleRows: new Set() };
    const sourceY = raw[0] === "" ? 1 : 0;
    content = { lines: raw.slice(sourceY), actions: new Map(), toggleRows: new Set(),
      native: { x: 0, y: 0, width: innerWidth, height: raw.length - sourceY, sourceY } };
  }
  const sections = new Map<number, { label: string; color: string }>();
  const native = content.native;
  if (native && owner.result && owner.expanded) {
    const self = owner.toolDefinition?.renderShell === "self";
    const call = (self ? owner.selfRenderContainer : owner.contentBox)?.children?.[0];
    if (call) {
      const callWidth = self ? native.width : Math.max(1, native.width - (owner.outputPad ?? 1) * 2);
      const start = native.y + (self ? 1 : 2) + call.render(callWidth).length - native.sourceY;
      if (start < content.lines.length) sections.set(start, { label: "Output", color: owner.result.isError ? "error" : "success" });
    }
  }
  const color = owner.result?.isError ? "error" : owner.result && !owner.isPartial ? "success" : "accent";
  const duration = !owner.isPartial && Number.isFinite(owner.result?.durationMs) ? owner.result.durationMs : undefined;
  const seconds = duration === undefined ? undefined : Math.max(0, duration) / 1000;
  const footer = seconds === undefined ? "" : seconds < 60 ? `Took ${seconds.toFixed(1)}s`
    : seconds < 3600 ? `Took ${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
    : `Took ${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${Math.floor(seconds % 60)}s`;
  const body = content.lines.slice();
  if (!owner.expanded && body.length) {
    const label = toolLabel(owner.toolName, owner.toolDefinition?.label);
    const plain = stripTerminalSequences(body[0]);
    const prefix = `● ${label}(`;
    if (plain.startsWith(prefix) && plain.endsWith(")")) {
      const start = visibleWidth(prefix);
      body[0] = (owner.toolName === "bash" ? theme.fg("toolTitle", "$ ") : "") +
        sliceByColumn(body[0], start, Math.max(0, visibleWidth(plain) - start - 1));
    } else if (plain === `● ${label}`) {
      body[0] = theme.fg("muted", "No arguments");
    }
    for (let row = 1; row < body.length; row++) {
      const result = /^(\s*└\s*)/.exec(stripTerminalSequences(body[row]));
      if (result) {
        const prefixWidth = visibleWidth(result[1]);
        const status = owner.result?.isError ? "✕ " : owner.result && !owner.isPartial ? "✓ " : "· ";
        body[row] = theme.fg(color === "accent" ? "dim" : color, status) +
          sliceByColumn(body[row], prefixWidth, Math.max(0, visibleWidth(body[row]) - prefixWidth));
        break;
      }
    }
  }
  const collapsible = !options.nested.count(owner.toolCallId);
  const title = toolLabel(owner.toolName, owner.toolDefinition?.label) + (collapsible ? ` ${owner.expanded ? "▾" : "▸"}` : "");
  const frame = frameNativeRows(title, body, width, theme,
    sections, owner, color, footer, color, color === "error" ? "toolErrorBg" : "toolPendingBg");
  const actions = new Map<number, string>();
  const toggleRows = new Set<number>();
  const sourceRows = new Map<number, number>();
  for (const [y, source] of frame.sourceRows) {
    const action = content.actions.get(source);
    if (action) actions.set(y, action);
    if (content.toggleRows.has(source)) toggleRows.add(y);
    if (native && source >= native.y && source < native.y + native.height) sourceRows.set(y, source - native.y + native.sourceY);
  }
  if (!options.nested.count(owner.toolCallId)) toggleRows.add(0);
  const lines = width < 8 ? frame.lines.map((line) => isNativeImageRow(line) ? line : truncateToWidth(line, Math.max(1, width), "")) : frame.lines;
  return { lines, actions, toggleRows, sourceRows: native ? sourceRows : undefined,
    native: native ? { ...native, x: frame.inset + native.x, y: 0 } : undefined };
}

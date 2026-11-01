import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  CompactionSummaryMessageComponent,
  CustomEditor,
  InteractiveMode,
  ToolExecutionComponent,
  UserMessageComponent,
  initTheme,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, TuiAltScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  ActivityTimeline,
  assistantTerminalState,
} from "../extensions/activity-timeline.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-pretty-tui-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
initTheme("dark", false);

// Snapshots taken before the extension is loaded so session_shutdown can be
// checked for a complete restore of every patched method.
const originalPrototypeMethods = [
  ["Markdown.invalidate", Markdown.prototype, "invalidate"],
  ["Markdown.render", Markdown.prototype, "render"],
  ["Markdown.renderToken", Markdown.prototype, "renderToken"],
  ["Markdown.handleMouse", Markdown.prototype, "handleMouse"],
  ["AssistantMessageComponent.setHideThinkingBlock", AssistantMessageComponent.prototype, "setHideThinkingBlock"],
  ["AssistantMessageComponent.updateContent", AssistantMessageComponent.prototype, "updateContent"],
  ["AssistantMessageComponent.render", AssistantMessageComponent.prototype, "render"],
  ["AssistantMessageComponent.handleMouse", AssistantMessageComponent.prototype, "handleMouse"],
  ["CompactionSummaryMessageComponent.render", CompactionSummaryMessageComponent.prototype, "render"],
  ["CompactionSummaryMessageComponent.handleMouse", CompactionSummaryMessageComponent.prototype, "handleMouse"],
  ["CustomMessageComponent.render", CustomMessageComponent.prototype, "render"],
  ["CustomMessageComponent.handleMouse", CustomMessageComponent.prototype, "handleMouse"],
  ["ToolExecutionComponent.markExecutionStarted", ToolExecutionComponent.prototype, "markExecutionStarted"],
  ["ToolExecutionComponent.setExpanded", ToolExecutionComponent.prototype, "setExpanded"],
  ["ToolExecutionComponent.render", ToolExecutionComponent.prototype, "render"],
  ["ToolExecutionComponent.handleMouse", ToolExecutionComponent.prototype, "handleMouse"],
  ["InteractiveMode.setToolsExpanded", InteractiveMode.prototype, "setToolsExpanded"],
  ["InteractiveMode.toggleToolOutputExpansion", InteractiveMode.prototype, "toggleToolOutputExpansion"],
  ["InteractiveMode.renderSessionEntries", InteractiveMode.prototype, "renderSessionEntries"],
  ["InteractiveMode.switchTuiMode", InteractiveMode.prototype, "switchTuiMode"],
  ["InteractiveMode.showExtensionNotify", InteractiveMode.prototype, "showExtensionNotify"],
  ["InteractiveMode.toggleThinkingBlockVisibility", InteractiveMode.prototype, "toggleThinkingBlockVisibility"],
  ["InteractiveMode.showStatus", InteractiveMode.prototype, "showStatus"],
  ["InteractiveMode.showWarning", InteractiveMode.prototype, "showWarning"],
  ["InteractiveMode.showError", InteractiveMode.prototype, "showError"],
  ["InteractiveMode.addCacheMissNotice", InteractiveMode.prototype, "addCacheMissNotice"],
  ["InteractiveMode.maybeShowCacheMissNotice", InteractiveMode.prototype, "maybeShowCacheMissNotice"],
  ["InteractiveMode.addMessageToChat", InteractiveMode.prototype, "addMessageToChat"],
  ["TuiAltScreen.handleSelectionMouseEvent", TuiAltScreen.prototype, "handleSelectionMouseEvent"],
  ["TuiAltScreen.handleMouseEvent", TuiAltScreen.prototype, "handleMouseEvent"],
  ["CustomEditor.render", CustomEditor.prototype, "render"],
  ["CustomEditor.renderTopBorder", CustomEditor.prototype, "renderTopBorder"],
  ["CustomEditor.handleMouse", CustomEditor.prototype, "handleMouse"],
  ["UserMessageComponent.rebuild", UserMessageComponent.prototype, "rebuild"],
].map(([label, target, method]) => [label, target, method, target[method]]);

const protoPatchKeys = [
  ["Markdown", Markdown.prototype, Symbol.for("pretty-tui.code-blocks")],
  ["AssistantMessageComponent", AssistantMessageComponent.prototype, Symbol.for("pretty-tui.clean-thinking")],
  ["CustomMessageComponent", CustomMessageComponent.prototype, Symbol.for("pretty-tui.clean-custom-message")],
  ["ToolExecutionComponent", ToolExecutionComponent.prototype, Symbol.for("pretty-tui.clean-tool-execution")],
  ["InteractiveMode", InteractiveMode.prototype, Symbol.for("pretty-tui.clean-tool-expansion")],
  ["CustomEditor", CustomEditor.prototype, Symbol.for("pretty-tui.rounded-editor-frame")],
  ["UserMessageComponent", UserMessageComponent.prototype, Symbol.for("pretty-tui.user-message-frame")],
  ["Markdown", Markdown.prototype, Symbol.for("pretty-tui.list-bullets")],
].map(([label, owner, symbol]) => ({ label, owner, symbol }));

const symbolPatchKeys = [
  ["TuiAltScreen", TuiAltScreen.prototype, Symbol.for("pretty-tui.clean-summary-click")],
].map(([label, owner, symbol]) => ({ label, owner, symbol }));

const jiti = createJiti(import.meta.url);
const extension = await jiti.import(join(process.cwd(), "extensions/index.ts"), { default: true });
const handlers = new Map();
const tools = new Map();
const toolResolvers = [];
const commands = new Map();
const entryRenderers = new Map();
const appendedEntries = [];
const widgets = new Map();
const pi = {
  appendEntry(type, data) { appendedEntries.push({ type, data }); },
  on(name, handler) {
    const eventHandlers = handlers.get(name) ?? [];
    eventHandlers.push(handler);
    handlers.set(name, eventHandlers);
  },
  registerCommand(name, command) { commands.set(name, command); },
  registerEntryRenderer(type, renderer) { entryRenderers.set(type, renderer); },
  registerToolRenderer(resolver) { toolResolvers.push(resolver); },
  getAllTools() { return []; },
};
extension(pi);
for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
  const resolve = (index) => index < toolResolvers.length
    ? toolResolvers[index](name, () => resolve(index + 1)) : undefined;
  tools.set(name, resolve(0));
}

const theme = {
  bold: (text) => text,
  fg: (_name, text) => text,
};
// Exercise Pi's real press/motion/release pipeline, not synthesized clicks.
const mouseGestureFixture = (component, lines, width = 100, nativeMultiClick = false) => {
  const height = Math.max(1, lines.length);
  const rect = { x: 0, y: 0, width, height };
  // Transcript projections are opaque leaves; do not fabricate layout boxes
  // for their old native children, whose coordinates no longer match the UI.
  const box = (item) => ({ component: item, rect, clip: rect, layer: 0, children: [] });
  const screen = Object.assign(Object.create(TuiAltScreen.prototype), {
    terminal: { rows: height, columns: width }, previousScreen: lines,
    currentLayout: { root: box(component), width, height, lines },
    copyOnSelect: false, hasOverlay: () => false,
    handleSearchMouseEvent: () => false, handleScrollToEndIndicatorMouseEvent: () => false,
    handleScrollbarMouseEvent: () => false, handleRightClickPaste: () => false,
    updateScrollbarHover() {}, stopScrollbarHover() {},
    stopSelectionAutoScroll() {}, updateSelectionAutoScroll() {}, requestRender() {},
    dispatchMouseToOverlay: () => ({ hit: false }), applyMouseDispatchResult: () => false,
  });
  if (!nativeMultiClick) screen.getClickCount = () => 1;
  return {
    screen,
    gesture(x, y, motions = [], release = undefined) {
      screen.handleMouseEvent({ button: 0, release: false, x, y });
      for (const [dx, dy] of motions) screen.handleMouseEvent({ button: 32, release: false, x: x + dx, y: y + dy });
      const [dx, dy] = release ?? motions.at(-1) ?? [0, 0];
      screen.handleMouseEvent({ button: 0, release: true, x: x + dx, y: y + dy });
    },
  };
};

const widgetText = () => {
  const factory = widgets.get("pretty-tui-latest-activity");
  if (!factory) return "";
  return factory({}, theme).render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
};
const emit = async (name, event = {}, ctx = sessionContext([])) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
const sessionContext = (entries) => ({
  sessionManager: { buildContextEntries: () => entries, getBranch: () => entries },
  ui: {
    getToolsExpanded: () => false,
    notify() {},
    setWidget(key, content) {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, content);
    },
  },
});
const assistant = (id, parentId, calls, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
  message: {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map(({ id: callId, name = "bash" }) => ({
        type: "toolCall",
        id: callId,
        name,
        arguments: name === "read" ? { path: "fixture.txt" } : { command: "true" },
      })),
    ],
  },
});
const result = (id, parentId, toolCallId, isError = false) => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.500Z`,
  message: { role: "toolResult", toolCallId, isError, content: [{ type: "text", text: "ok" }] },
});
const user = (id, parentId, text = "user") => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.750Z`,
  message: { role: "user", content: [{ type: "text", text }] },
});
const summary = (id, parentId, groups) => ({
  type: "custom",
  customType: "pretty-tui-tool-summary",
  id,
  parentId,
  timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.700Z`,
  data: {
    count: groups.reduce((total, group) => total + group.count, 0),
    failed: groups.reduce((total, group) => total + (group.failed ?? 0), 0),
    lastToolCallId: groups.at(-1)?.lastToolCallId,
    groups,
  },
});
const renderCollapsedSummaries = async (entries) => {
  await emit("session_start", {}, sessionContext(entries));
  const visible = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const item of entry.message.content ?? []) {
      if (item.type !== "toolCall" || !tools.has(item.name)) continue;
      const component = tools.get(item.name).renderCall(item.arguments, theme, {
        toolCallId: item.id,
        expanded: false,
        executionStarted: true,
        state: {},
      });
      const output = component.render(100).join("\n");
      if (output.trim()) visible.push({ entryIndex, id: item.id, output });
    }
  }
  return visible;
};
const counts = (visible) => visible.map(({ output }) => Number(/Done\((\d+) tool/.exec(output)?.[1]));

// Built-in compact call parameters share the muted role with nested calls.
{
  const colors = [];
  const parameterTheme = { ...theme, fg(color, text) { colors.push([text, color]); return text; } };
  const fixtures = [
    ["read", { path: "COLOR_PARAMETER" }],
    ["bash", { command: "COLOR_PARAMETER" }],
    ["edit", { path: "COLOR_PARAMETER", oldText: "old", newText: "new" }],
    ["write", { path: "COLOR_PARAMETER", content: "fixture" }],
    ["grep", { pattern: "COLOR_PARAMETER" }],
    ["find", { pattern: "COLOR_PARAMETER" }],
    ["ls", { path: "COLOR_PARAMETER" }],
  ];
  for (const [name, args] of fixtures) {
    colors.length = 0;
    const component = tools.get(name).renderCall(args, parameterTheme, {
      toolCallId: `parameter-color-${name}`, expanded: true, executionStarted: true, state: {},
    });
    component.render(100);
    assert.ok(colors.some(([text, color]) => text.includes("COLOR_PARAMETER") && color === "muted"), name);
    assert.ok(!colors.some(([text, color]) => text.includes("COLOR_PARAMETER") && color === "text"), name);
  }
}

// Read range labels normalize numeric strings without changing execution args.
// Null means an omitted optional field; malformed ranges must not be invented.
{
  const fixtures = [
    [{ offset: 10, limit: 5 }, " · lines 10–14"],
    [{ offset: "10", limit: "5" }, " · lines 10–14"],
    [{ offset: " 10 ", limit: 5 }, " · lines 10–14"],
    [{ offset: 10, limit: "5" }, " · lines 10–14"],
    [{ offset: null, limit: "5" }, " · lines 1–5"],
    [{ limit: 5 }, " · lines 1–5"],
    [{ offset: "10", limit: null }, " · lines 10+"],
    [{ offset: 10 }, " · lines 10+"],
    [{ offset: null, limit: null }, ""],
    [{}, ""],
    [{ offset: "", limit: 5 }, ""],
    [{ offset: "  ", limit: 5 }, ""],
    [{ offset: "invalid", limit: 5 }, ""],
    [{ offset: 10, limit: "invalid" }, ""],
    [{ offset: NaN, limit: 5 }, ""],
    [{ offset: 10, limit: Infinity }, ""],
    [{ offset: true, limit: 5 }, ""],
    [{ offset: 10, limit: {} }, ""],
  ];
  for (const [range, suffix] of fixtures) {
    const args = Object.freeze({ path: "range-fixture.ts", ...range });
    const component = tools.get("read").renderCall(args, theme, {
      toolCallId: "read-range-fixture", expanded: true, executionStarted: true, state: {},
    });
    const output = stripTerminalSequences(component.render(120).join("\n")).trim();
    assert.equal(output, `● read(range-fixture.ts${suffix})`, JSON.stringify(range));
  }
}

// Edit diffs have a fixed, right-aligned number gutter before +/- markers.
// Continuations keep both gutter columns blank and preserve code indentation.
{
  const diff = [
    "    ...",
    "   9 CONTEXT",
    "- 10   DELETE " + "old words ".repeat(12),
    "+100   ADD " + "新增内容 ".repeat(15),
    " 101 ",
    "    ...",
  ].join("\n");
  const renderEdit = (width, expanded = true, isError = false, details = { diff }) => {
    const colors = [];
    const editTheme = { ...theme, fg(color, text) { colors.push([color, text]); return text; } };
    const component = tools.get("edit").renderResult(
      { content: [{ type: "text", text: isError ? "Edit failed: original text not found" : "Updated" }], details },
      { expanded, isPartial: false }, editTheme,
      { toolCallId: "edit-gutter-fixture", executionStarted: true, isError, state: {} },
    );
    return { rows: component.render(width).map(stripTerminalSequences), colors };
  };
  for (const width of [38, 120]) {
    const { rows, colors } = renderEdit(width);
    const context = rows.find((line) => line.includes("CONTEXT"));
    const removed = rows.find((line) => line.includes("DELETE"));
    const added = rows.find((line) => line.includes("ADD"));
    assert.equal(context.indexOf("9"), 7);
    assert.equal(removed.indexOf("10"), 6);
    assert.equal(added.indexOf("100"), 5);
    assert.equal(removed.indexOf("-"), 9);
    assert.equal(added.indexOf("+"), 9);
    assert.equal(context.indexOf("CONTEXT"), 11);
    assert.equal(removed.indexOf("DELETE"), 13); // two spaces of code indentation
    assert.equal(added.indexOf("ADD"), 13);
    assert.ok(rows.every((line) => visibleWidth(line) <= width));
    assert.ok(rows.some((line) => /^   │ {7}old/.test(line)), "wrapped code starts after the gutter");
    assert.ok(rows.filter((line) => line.includes("...")).every((line) => line.indexOf("...") === 11));
    assert.ok(rows.some((line) => line.includes("101")), "blank source lines keep their number");
    assert.ok(colors.some(([color, text]) => color === "toolDiffAdded" && text.startsWith("  ADD")));
    assert.ok(colors.some(([color, text]) => color === "toolDiffRemoved" && text.startsWith("  DELETE")));
    assert.ok(colors.some(([color, text]) => color === "toolDiffContext" && text === "CONTEXT"));
    assert.ok(rows[0].includes("Updated · +1 -1"));
  }
  assert.ok(!renderEdit(80, false).rows.join("\n").includes("DELETE"));
  assert.ok(renderEdit(80, true, true, {}).rows.join("\n").includes("Edit failed: original text not found"));
  // Unknown diff formats must remain visible, not be dropped by the parser.
  const raw = renderEdit(80, true, false, { diff: "@@ raw header @@\n+++ file\n-unparsed text" }).rows.join("\n");
  assert.ok(raw.includes("@@ raw header @@"));
  assert.ok(raw.includes("+++ file"));
  assert.ok(raw.includes("-unparsed text"));
}

// User messages render as transparent, right-aligned chat bubbles. Short text
// determines the bubble width; long text wraps at 75% of the terminal width.
{
  const bubbleContext = sessionContext([]);
  bubbleContext.ui.theme = {
    fg(name, text) {
      return name === "mdHeading" ? `<mdHeading>${text}</mdHeading>` : text;
    },
  };
  await emit("session_start", {}, bubbleContext);
  const plainLines = (component, width) => component.render(width).map((line) =>
    stripTerminalSequences(line).replaceAll("<mdHeading>", "").replaceAll("</mdHeading>", ""),
  );
  const frameBounds = (line) => {
    const start = line.indexOf("╭");
    const end = line.indexOf("╮", start);
    return { start, width: visibleWidth(line.slice(start, end + 1)) };
  };

  const shortBubble = new UserMessageComponent("已发布");
  const shortRaw = shortBubble.render(80);
  const shortLines = plainLines(shortBubble, 80);
  const shortFrame = frameBounds(shortLines[0]);
  assert.ok(shortRaw[0].includes("<mdHeading>"), shortRaw[0]);
  assert.ok(!shortLines.join("\n").includes("User"), shortLines.join("\n"));
  assert.equal(shortFrame.width, 10);
  assert.equal(shortFrame.start, 69);
  assert.ok(shortLines.some((line) => line.includes("已发布")));
  assert.ok(!shortRaw.join("\n").match(/\x1b\[(?:4[0-9]|10[0-7]|48(?:;|:))/));

  // Pi 1.0 puts background/padding on Markdown itself, not an outer Box.
  // Native rebuilds (e.g. output padding changes) must normalize that too.
  shortBubble.setOutputPad(2);
  const rebuiltRaw = shortBubble.render(80);
  const rebuiltFrame = frameBounds(plainLines(shortBubble, 80)[0]);
  assert.equal(rebuiltFrame.width, 10);
  assert.equal(rebuiltFrame.start, 68);
  assert.ok(!rebuiltRaw.join("\n").match(/\x1b\[(?:4[0-9]|10[0-7]|48(?:;|:))/));

  const longText = "A long user message should wrap inside a bounded chat bubble while preserving a clear blank area on its left side. ".repeat(3);
  const longBubble = new UserMessageComponent(longText);
  const longLines = plainLines(longBubble, 80);
  const longFrame = frameBounds(longLines[0]);
  assert.ok(longFrame.width <= 60 && longFrame.width >= 50, longLines[0]);
  assert.equal(longFrame.start, 79 - longFrame.width);
  assert.ok(longFrame.start >= 19, longLines[0]);
  assert.ok(longLines.length > 4, longLines.join("\n"));
  for (const line of longLines) assert.equal(visibleWidth(line), 80, line);

  const narrowLines = plainLines(longBubble, 20);
  assert.ok(frameBounds(narrowLines[0]).start >= 1, narrowLines[0]);
  for (const line of narrowLines) assert.equal(visibleWidth(line), 20, line);

  const modeContext = { hasUI: true, ui: { notify() {} } };
  bubbleContext.ui.theme.bg = (_role, text) => "\x1b[48;5;236m" + text + "\x1b[49m";
  await commands.get("pretty-tui").handler("full", modeContext);
  assert.ok(shortBubble.render(80).every((line) => line.includes("\x1b[48;5;236m")), "User uses the shared panel background");
  for (const width of [8, 20, 80]) {
    const fullRows = plainLines(shortBubble, width);
    assert.equal(frameBounds(fullRows[0]).start, width >= 20 ? 1 : 0);
    assert.equal(frameBounds(fullRows[0]).width, width - (width >= 20 ? 2 : 0));
    assert.ok(fullRows.every((line) => visibleWidth(line) === width));
    if (width >= 9) assert.ok(fullRows[0].trimStart().startsWith("╭─ User "));
  }
  shortBubble.setOutputPad(5);
  assert.equal(frameBounds(plainLines(shortBubble, 80)[0]).width, 78, "full width ignores adaptive bubble padding");
  assert.equal(frameBounds(plainLines(shortBubble, 80)[0]).start, 1);
  const fullLongRows = plainLines(longBubble, 80);
  assert.equal(frameBounds(fullLongRows[0]).width, 78);
  assert.ok(fullLongRows.length < longLines.length, "full uses the extra width for body text");
  for (const mode of ["compact", "clean"]) {
    await commands.get("pretty-tui").handler(mode, modeContext);
    const adaptive = plainLines(shortBubble, 80);
    assert.equal(frameBounds(adaptive[0]).width, mode === "compact" ? 78 : 10);
    assert.ok(frameBounds(adaptive[0]).start > 0);
    assert.equal(adaptive[0].includes("User"), mode === "compact");
  }
}

// The transcript-first model keeps thinking, tools, and updates in order
// across explicit transcript boundaries.
{
  const timeline = new ActivityTimeline();
  timeline.addThinking("m1", "Plan the work");
  timeline.addTool("native", "read");
  timeline.addTool("third-party", "obs_recall");
  timeline.boundary();
  timeline.addThinking("m2", "Recover after the boundary");
  timeline.addTool("after-error", "web_search");
  assert.deepEqual(
    timeline.groups().map((group) => group.members.map((member) => member.kind === "tool" ? member.toolCallId : member.messageKey)),
    [["m1", "native", "third-party"], ["m2", "after-error"]],
  );
  assert.deepEqual(timeline.groups().map((group) => group.thoughtCount), [1, 1]);
  timeline.addThinking("m2", "Updated streaming thought");
  assert.equal(timeline.groups()[1].thoughtCount, 1);
  timeline.addUpdate("update-1", "Extension Info", "Details", false);
  assert.deepEqual(
    timeline.groups()[1].members.map((member) => member.kind),
    ["thinking", "tool", "update"],
  );
  timeline.boundary();
  timeline.addPendingUpdate("pending-update", "Content Ready", "Fetched", true);
  timeline.addThinking("m3", "Use fetched content");
  timeline.addTool("after-pending-update", "web_search");
  assert.deepEqual(
    timeline.groups()[2].members.map((member) => member.kind),
    ["update", "thinking", "tool"],
  );
  assert.equal(assistantTerminalState({ role: "assistant", stopReason: "error", content: [] }), true);
  assert.equal(assistantTerminalState({ role: "assistant", stopReason: "toolUse", content: [] }), false);
}

// A group formed by the first thought must already accept update members: the
// activity group exists before any tool has run, so "has work" cannot mean
// "has tools". This is the single definition every caller relies on.
{
  const timeline = new ActivityTimeline();
  assert.equal(timeline.hasWork(undefined), false);
  timeline.addThinking("thought-only", "Plan before acting");
  const group = timeline.currentGroup();
  assert.equal(timeline.hasWork(group), true);
  assert.deepEqual(group.toolCallIds, []);
  assert.equal(timeline.addUpdate("thought-only-update", "Index ready", "body", false)?.kind, "update");
  assert.deepEqual(group.members.map((member) => member.kind), ["thinking", "update"]);
  const started = new ActivityTimeline();
  started.addTool("t1", "read");
  assert.equal(started.hasWork(started.currentGroup()), true);
}

// Restored groups derive thought counts from transcript members, including
// summaries written before thoughtCount was persisted.
{
  const thinkingCall = assistant("00", null, [{ id: "thought-tool" }]);
  thinkingCall.message.content.unshift({ type: "thinking", thinking: "Plan" });
  const visible = await renderCollapsedSummaries([
    thinkingCall,
    result("01", "00", "thought-tool"),
    summary("02", "01", [{
      count: 1,
      failed: 0,
      lastToolCallId: "thought-tool",
      toolCallIds: ["thought-tool"],
    }]),
  ]);
  assert.ok(visible[0].output.includes("1 thought"));
}

// A persisted summary may include an orphaned call without a toolResult. It
// must replace, rather than stack with, a larger inferred fallback summary.
{
  const entries = [
    assistant("01", null, [{ id: "done" }, { id: "orphan" }]),
    result("02", "01", "done"),
    summary("03", "02", [{ count: 1, failed: 0, lastToolCallId: "done", toolCallIds: ["done", "orphan"] }]),
    user("04", "03"),
  ];
  assert.deepEqual(counts(await renderCollapsedSummaries(entries)), [1]);
}

// Old summaries that crossed a steering message are split at the user entry.
{
  const entries = [
    assistant("10", null, [{ id: "before-steer" }]),
    result("11", "10", "before-steer"),
    user("12", "11", "steer"),
    assistant("13", "12", [{ id: "after-steer-1" }, { id: "after-steer-2" }]),
    result("14", "13", "after-steer-1"),
    result("15", "14", "after-steer-2"),
    summary("16", "15", [{
      count: 3,
      failed: 0,
      lastToolCallId: "after-steer-2",
      toolCallIds: ["before-steer", "after-steer-1", "after-steer-2"],
    }]),
  ];
  const visible = await renderCollapsedSummaries(entries);
  assert.deepEqual(counts(visible), [1, 2]);
  assert.ok(visible[0].entryIndex < 2 && visible[1].entryIndex > 2);
}

// buildContextEntries prepends compaction for model context. Restoration must
// put it back chronologically, then split a legacy cross-compaction summary.
{
  const beforeCall = assistant("20", null, [{ id: "before-compact" }]);
  const beforeResult = result("21", "20", "before-compact");
  const compaction = {
    type: "compaction",
    id: "compact",
    parentId: "21",
    timestamp: "2026-01-01T00:00:21.600Z",
  };
  const afterCall = assistant("22", "compact", [{ id: "after-compact-1" }, { id: "after-compact-2" }]);
  const afterResult1 = result("23", "22", "after-compact-1");
  const afterResult2 = result("24", "23", "after-compact-2");
  const durable = summary("25", "24", [{
    count: 3,
    failed: 0,
    lastToolCallId: "after-compact-2",
    toolCallIds: ["before-compact", "after-compact-1", "after-compact-2"],
  }]);
  const visible = await renderCollapsedSummaries([
    compaction,
    beforeCall,
    beforeResult,
    afterCall,
    afterResult1,
    afterResult2,
    durable,
  ]);
  assert.deepEqual(counts(visible), [1, 2]);
}

// Parallel tool completion order can choose a different durable owner than
// transcript order. Only the durable owner may render a summary row.
{
  const entries = [
    assistant("30", null, [{ id: "parallel-a", name: "read" }, { id: "parallel-b", name: "read" }]),
    result("31", "30", "parallel-a"),
    result("32", "31", "parallel-b"),
    summary("33", "32", [{
      count: 2,
      failed: 0,
      lastToolCallId: "parallel-a",
      toolCallIds: ["parallel-a", "parallel-b"],
    }]),
  ];
  assert.deepEqual(counts(await renderCollapsedSummaries(entries)), [2]);
}

// Live steering and compaction events must create hard boundaries before the
// final durable summary is appended.
{
  appendedEntries.length = 0;
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const runTool = async (toolCallId) => {
    await emit("tool_execution_start", { toolName: "bash", toolCallId });
    await emit("tool_execution_end", { toolName: "bash", toolCallId, isError: false });
  };
  await runTool("live-before-steer");
  await emit("message_start", { message: { role: "user", content: [{ type: "text", text: "steer" }] } });
  await runTool("live-before-compact");
  await emit("session_before_compact", { reason: "threshold", willRetry: false });
  const compactingComponent = new ToolExecutionComponent(
    "obs_recall",
    "live-before-compact",
    {},
    undefined,
    { renderShell: "self", renderCall: () => new Text("recall", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  const compactingText = compactingComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(compactingText.includes("Done(1 tool call)"));
  assert.ok(!compactingText.includes("Running("));
  await emit("session_compact");
  await runTool("live-after-compact");
  await emit("agent_settled");
  assert.deepEqual(
    appendedEntries.at(-1).data.groups.map((group) => group.lastToolCallId),
    ["live-before-steer", "live-before-compact", "live-after-compact"],
  );
}

// Visible assistant text settles the prior group directly as Done; it never
// leaves a stale Running(... · responding...) row behind.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  await emit("tool_execution_start", { toolName: "web_search", toolCallId: "before-response" });
  await emit("tool_execution_end", { toolName: "web_search", toolCallId: "before-response", isError: false });
  await emit("message_update", {
    message: {
      role: "assistant",
      timestamp: 9876,
      content: [{ type: "text", text: "Visible response" }],
    },
  });
  const responseBoundaryComponent = new ToolExecutionComponent(
    "web_search",
    "before-response",
    {},
    undefined,
    { renderShell: "self", renderCall: () => new Text("search", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  const responseBoundaryText = responseBoundaryComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(responseBoundaryText.includes("Done(1 tool call)"));
  assert.ok(!responseBoundaryText.includes("responding"));
}

// Late thinking must not reopen a group across an already-visible response.
// Repeated snapshots of that response must not seal its subsequent tool group.
{
  const body = "INLINE_BOUNDARY_RESPONSE";
  for (const order of ["thought-first", "text-first", "all-at-once"]) {
    await emit("session_start", {}, sessionContext([]));
    await emit("agent_start");
    const timestamp = `inline-boundary-${order}`;
    const thought = { type: "thinking", thinking: "Inspect the ledger" };
    const text = { type: "text", text: body };
    const calls = [
      { type: "toolCall", id: `${timestamp}-a`, name: "obs_recall", arguments: {} },
      { type: "toolCall", id: `${timestamp}-b`, name: "obs_recall", arguments: {} },
    ];
    const message = { role: "assistant", timestamp, stopReason: "toolUse", content: [thought, text, ...calls] };
    if (order !== "all-at-once") {
      const first = order === "text-first" ? text : thought;
      await emit("message_update", { message: { ...message, content: [first] } });
      await emit("message_update", { message: { ...message, content: [thought, text] } });
    }
    await emit("message_end", { message });
    const assistantComponent = new AssistantMessageComponent(message);
    const tools = calls.map((call) => new ToolExecutionComponent(
      call.name, call.id, call.arguments, undefined,
      { renderShell: "self", renderCall: () => new Text("BOUNDARY_TOOL_DETAIL", 0, 0) },
      { requestRender() {} }, process.cwd(),
    ));
    for (let index = 0; index < calls.length; index++) {
      tools[index].markExecutionStarted();
      await emit("tool_execution_start", { toolCallId: calls[index].id, toolName: calls[index].name, args: {} });
    }
    // A late repeat of the same message must leave the new group running.
    await emit("message_update", { message });
    const initialThoughtRows = assistantComponent.render(120);
    assistantComponent.handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 120, height: initialThoughtRows.length });
    const initialToolRows = tools[0].render(120);
    tools[0].handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 120, height: initialToolRows.length });
    const render = () => [
      ...assistantComponent.render(120), ...tools.flatMap((tool) => tool.render(120)),
    ].map(stripTerminalSequences);
    const rows = render();
    const bodyY = rows.findIndex((line) => line.includes(body));
    const runningY = rows.findIndex((line) => line.includes("Running("));
    assert.ok(rows.some((line) => line.includes("Done(1 thought)")), `${order}: ${rows.join("\n")}`);
    assert.ok(runningY > bodyY, `${order}: tools must start a separate group after the response`);
    assert.match(rows[runningY], /Running\(2 tool calls/);
    assert.equal(rows.filter((line) => line.includes(body)).length, 1);
    assert.ok(rows.slice(0, bodyY).some((line) => line.includes("[↑ Collapse]")));
    assert.ok(rows.at(-1).includes("[↑ Collapse]"));
    // Folding the thought group must neither hide the response nor tool group.
    assistantComponent.handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 120, height: assistantComponent.render(120).length });
    const collapsed = render().join("\n");
    assert.ok(collapsed.includes(body));
    assert.ok(collapsed.includes("Running(2 tool calls"));
    assert.ok(collapsed.includes("obs_recall"));
    await emit("agent_settled");
    assert.ok(!render().join("\n").includes("Running("));
  }
}

// A group closed before its root tool completed must not keep consuming the
// next group's global live counters. Only the current ActivityTimeline group may
// render Running; historical groups fall back to Done rather than stale snapshots.
{
  const originalNow = Date.now;
  let now = 20_000;
  Date.now = () => now;
  try {
    await emit("session_start", {}, sessionContext([]));
    await emit("agent_start");
    await emit("tool_execution_start", { toolName: "fabric_exec", toolCallId: "orphaned-root" });
    await emit("message_update", {
      message: {
        role: "assistant",
        timestamp: 9988,
        content: [{ type: "text", text: "Boundary while the prior tool is pending" }],
      },
    });
    await emit("tool_execution_start", { toolName: "fabric_exec", toolCallId: "current-root" });

    const makeRoot = (toolCallId) => new ToolExecutionComponent(
      "fabric_exec",
      toolCallId,
      {},
      undefined,
      { renderShell: "self", renderCall: () => new Text("fabric", 0, 0) },
      { requestRender() {} },
      process.cwd(),
    );
    const orphanedText = makeRoot("orphaned-root").render(100).join("\n")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const currentText = makeRoot("current-root").render(100).join("\n")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    assert.ok(orphanedText.includes("Done(1 tool call)"), orphanedText);
    assert.ok(!orphanedText.includes("Running("), orphanedText);
    assert.ok(currentText.includes("Running("), currentText);

    now += 2_000;
    await emit("tool_execution_end", { toolName: "fabric_exec", toolCallId: "current-root", isError: false });
    await emit("agent_settled");
    const settledText = makeRoot("current-root").render(100).join("\n")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    assert.ok(settledText.includes("Done(1 tool call)"), settledText);
    assert.ok(!settledText.includes("Running("), settledText);
  } finally {
    Date.now = originalNow;
  }
}

// Assistant/system errors are standalone hard boundaries, so a later retry
// starts a fresh activity group.
{
  appendedEntries.length = 0;
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  await emit("tool_execution_start", { toolName: "bash", toolCallId: "before-system-error" });
  await emit("tool_execution_end", { toolName: "bash", toolCallId: "before-system-error", isError: false });
  await emit("message_end", {
    message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed", content: [] },
  });
  await emit("tool_execution_start", { toolName: "obs_recall", toolCallId: "after-system-error" });
  await emit("tool_execution_end", { toolName: "obs_recall", toolCallId: "after-system-error", isError: false });
  await emit("agent_settled");
  assert.deepEqual(
    appendedEntries.at(-1).data.groups.map((group) => group.lastToolCallId),
    ["before-system-error", "after-system-error"],
  );
  assert.deepEqual(
    appendedEntries.at(-1).data.groups.map((group) => group.toolCallIds),
    [["before-system-error"], ["after-system-error"]],
  );
}

// A host that cannot accept transcript components must not leak an extension
// notification into the transient UI flash. The fallback routes straight to
// Pi's original method for that severity instead of re-entering the patched
// showStatus/showWarning/showError, and degrades to nothing when even the
// original cannot render on that host.
{
  widgets.clear();
  await emit("session_start", {}, sessionContext([]));
  const unreachableHost = { ui: { requestRender() {} }, chatContainer: {} };
  for (const severity of ["info", "warning", "error"]) {
    assert.doesNotThrow(() => {
      InteractiveMode.prototype.showExtensionNotify.call(
        unreachableHost,
        `Unreachable ${severity}`,
        severity,
      );
    });
  }
  assert.equal(widgets.has("pretty-tui-latest-activity"), false);
}

// An informational notification without existing model/tool work remains an
// independent update and never attaches itself to a later tool group.
{
  await emit("session_start", {}, sessionContext([]));
  const pendingInfoComponents = [];
  const pendingInfoHost = {
    ui: { requestRender() {} },
    chatContainer: { addChild(component) { pendingInfoComponents.push(component); } },
    showStatus() { assert.fail("pending info should remain extension-rendered"); },
  };
  InteractiveMode.prototype.showExtensionNotify.call(
    pendingInfoHost,
    "Indexing complete\n2,770 context tokens avoided",
    "info",
  );
  assert.equal(pendingInfoComponents.length, 1);
  const standaloneInfo = pendingInfoComponents[0].render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(standaloneInfo.includes("Indexing complete"));
  assert.ok(standaloneInfo.includes("2,770 context tokens avoided"));
  await emit("agent_start");
  await emit("tool_execution_start", { toolName: "bash", toolCallId: "after-pending-info" });
  const pendingInfoParent = pendingInfoComponents[0].render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(!pendingInfoParent.includes("Running("));
  assert.ok(pendingInfoParent.includes("Indexing complete"));
  assert.ok(pendingInfoParent.includes("2,770 context tokens avoided"));
  await emit("tool_execution_end", { toolName: "bash", toolCallId: "after-pending-info", isError: false });
  await emit("agent_settled");
}

// A final assistant message may contain both thinking and visible answer text.
// Its Thought remains in the preceding group without retaining Pi's native
// Thinking MouseRegion or hiding the visible response.
{
  const first = {
    type: "message",
    id: "20",
    parentId: null,
    timestamp: "2026-01-01T00:00:20.000Z",
    message: {
      role: "assistant",
      timestamp: 20_000,
      content: [
        { type: "thinking", thinking: "Plan mixed response" },
        { type: "toolCall", id: "mixed-tool", name: "obs_recall", arguments: {} },
      ],
    },
  };
  const mixed = {
    type: "message",
    id: "22",
    parentId: "21",
    timestamp: "2026-01-01T00:00:22.000Z",
    message: {
      role: "assistant",
      timestamp: 22_000,
      content: [
        { type: "thinking", thinking: "Summarize mixed response" },
        { type: "text", text: "Visible final answer" },
      ],
    },
  };
  await emit("session_start", {}, sessionContext([
    first,
    result("21", "20", "mixed-tool"),
    mixed,
  ]));
  const firstComponent = new AssistantMessageComponent(first.message);
  const mixedComponent = new AssistantMessageComponent(mixed.message);
  const collapsedMixed = mixedComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(collapsedMixed.includes("Visible final answer"));
  firstComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: firstComponent.render(80).length,
  });
  const compactMixed = mixedComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(compactMixed.includes("● thought"));
  assert.ok(compactMixed.includes("Visible final answer"));
  assert.ok(!compactMixed.includes("Thinking..."));
  const cachedMixed = mixedComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(cachedMixed.includes("Visible final answer"));
  mixedComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 0, width: 80, height: mixedComponent.render(80).length,
  });
  const expandedMixed = mixedComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(expandedMixed.includes("Summarize mixed response"));
  assert.ok(expandedMixed.includes("Visible final answer"));
  assert.ok(!expandedMixed.includes("Thinking..."));
}

// A normal response can contain Thinking plus visible text without making any
// tool call. Clean mode must never hide that final answer behind a tool-only
// activity projection.
{
  const noToolMixed = {
    type: "message",
    id: "25",
    parentId: null,
    timestamp: "2026-01-01T00:00:25.000Z",
    message: {
      role: "assistant",
      timestamp: 25_000,
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Finalize without tools" },
        { type: "text", text: "Visible answer without tool calls" },
      ],
    },
  };
  await emit("session_start", {}, sessionContext([noToolMixed]));
  const noToolMixedComponent = new AssistantMessageComponent(noToolMixed.message);
  const noToolMixedText = noToolMixedComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(noToolMixedText.includes("Visible answer without tool calls"));
}

// If a transcript rebuild resets timeline ownership before an older assistant
// component is discarded, visible text must fail open instead of disappearing.
{
  const rebuildingMixed = {
    role: "assistant",
    timestamp: 26_000,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "Survive timeline reset" },
      { type: "text", text: "Visible answer during rebuild" },
    ],
  };
  await emit("session_start", {}, sessionContext([]));
  const rebuildingComponent = new AssistantMessageComponent(rebuildingMixed);
  await emit("session_start", {}, sessionContext([]));
  const rebuildingText = rebuildingComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(rebuildingText.includes("Visible answer during rebuild"));
}

// A displayed custom message arriving after visible text remains an independent
// durable Activity Update instead of attaching itself to the next tool group.
{
  const before = assistant("27", null, [{ id: "before-pending-update", name: "web_search" }]);
  const visibleBoundary = assistant("29", "28", [], "Initial answer");
  const pendingCustomEntry = {
    type: "custom_message",
    id: "30",
    parentId: "29",
    timestamp: "2026-01-01T00:00:30.000Z",
    customType: "web-search-content-ready",
    content: "Content fetched for the next turn",
    display: true,
  };
  const after = assistant("31", "30", [{ id: "after-pending-update", name: "web_search" }]);
  after.message.content.unshift({ type: "thinking", thinking: "Use newly fetched content" });
  await emit("session_start", {}, sessionContext([
    before,
    result("28", "27", "before-pending-update"),
    visibleBoundary,
    pendingCustomEntry,
    after,
    result("32", "31", "after-pending-update"),
  ]));
  const pendingCustomMessage = {
    role: "custom",
    timestamp: pendingCustomEntry.timestamp,
    customType: pendingCustomEntry.customType,
    content: pendingCustomEntry.content,
    display: true,
  };
  const pendingCustomComponent = new CustomMessageComponent(pendingCustomMessage);
  const pendingParent = pendingCustomComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(!pendingParent.includes("Done("));
  assert.ok(!pendingParent.includes("[web-search-content-ready]"));
  assert.ok(pendingParent.includes("Web Search Content Ready"));
  assert.ok(pendingParent.includes("Content fetched for the next turn"));
}

// A displayed custom message injected directly by an extension can render
// before Pi emits a model message_start event. Clean mode must claim it at the
// component boundary instead of falling back to Pi's purple custom-message box,
// and rich Markdown must keep its formatting.
{
  await emit("session_start", {}, sessionContext([]));
  const liveCustomMessage = {
    role: "custom",
    timestamp: 33_000,
    customType: "plannotator-complete",
    content: "**Plan Complete!** ✓\n\n- [x] ~~Finish compatibility work.~~",
    display: true,
  };
  const liveCustomComponent = new CustomMessageComponent(liveCustomMessage);
  const liveCustomText = liveCustomComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(liveCustomText.includes("Plannotator Complete"));
  assert.ok(liveCustomText.includes("Plan Complete! ✓"));
  assert.ok(liveCustomText.includes("Finish compatibility work."));
  assert.ok(!liveCustomText.includes("[plannotator-complete]"));
  assert.ok(!liveCustomText.includes("**") && !liveCustomText.includes("~~"));

  const restoredCustomEntry = {
    type: "custom_message",
    id: "33-restored",
    parentId: null,
    timestamp: "2026-01-01T00:00:33.000Z",
    customType: liveCustomMessage.customType,
    content: liveCustomMessage.content,
    display: true,
  };
  await emit("session_start", {}, sessionContext([restoredCustomEntry]));
  const restoredCustomComponent = new CustomMessageComponent({
    ...liveCustomMessage,
    timestamp: restoredCustomEntry.timestamp,
  });
  const restoredCustomText = restoredCustomComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(restoredCustomText.includes("Plannotator Complete"));
  assert.ok(restoredCustomText.includes("Plan Complete! ✓"));
  assert.ok(!restoredCustomText.includes("[plannotator-complete]"));
  assert.ok(!restoredCustomText.includes("**") && !restoredCustomText.includes("~~"));
}

// Displayed custom messages with a registered semantic renderer remain native
// standalone blocks and release timeline ownership before the next tool row.
{
  const semanticBefore = assistant("32", null, [{ id: "semantic-before-tool", name: "read" }]);
  const semanticEntry = {
    type: "custom_message",
    id: "34",
    parentId: "33",
    timestamp: "2026-01-01T00:00:34.000Z",
    customType: "background-task-notification",
    content: "<background-task-notification>model payload</background-task-notification>",
    display: true,
  };
  const semanticToolCall = assistant("35", "34", [{ id: "semantic-next-tool", name: "read" }]);
  await emit("session_start", {}, sessionContext([
    semanticBefore,
    result("33", "32", "semantic-before-tool"),
    semanticEntry,
    semanticToolCall,
    result("36", "35", "semantic-next-tool"),
  ]));
  let semanticMouseCalls = 0;
  const semanticRenderer = () => ({
    render: () => ["[bg completed] compatibility test"],
    invalidate() {},
    handleMouse: () => {
      semanticMouseCalls++;
      return { handled: true };
    },
  });
  const semanticMessage = {
    role: "custom",
    timestamp: semanticEntry.timestamp,
    customType: semanticEntry.customType,
    content: semanticEntry.content,
    display: true,
  };
  const semanticComponent = new CustomMessageComponent(semanticMessage, semanticRenderer);
  const semanticText = semanticComponent.render(80).join("\n");
  assert.ok(semanticText.includes("[bg completed] compatibility test"));
  assert.ok(!semanticText.includes("model payload"));
  assert.equal(semanticComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: 2,
  })?.handled, true);
  assert.equal(semanticMouseCalls, 1);

  const semanticBeforeTool = new ToolExecutionComponent(
    "read",
    "semantic-before-tool",
    { path: "before-semantic.txt" },
    undefined,
    { renderShell: "self", renderCall: () => new Text("before semantic", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  const semanticBeforeText = semanticBeforeTool.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(semanticBeforeText.includes("Done(1 tool call"), semanticBeforeText);

  const semanticTool = new ToolExecutionComponent(
    "read",
    "semantic-next-tool",
    { path: "semantic.txt" },
    undefined,
    { renderShell: "self", renderCall: () => new Text("semantic tool", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  semanticTool.markExecutionStarted();
  const semanticToolText = semanticTool.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(semanticToolText.includes("Done(1 tool call"), semanticToolText);
}

// Persisted custom_message entries restore in transcript order inside their
// activity group. The tree position is what proves the restore branch ran: when
// it is skipped, the component-boundary fallback claims the message later and
// appends it as the last member instead.
{
  const firstCall = assistant("40", null, [{ id: "restored-custom-tool", name: "obs_recall" }]);
  const customEntry = {
    type: "custom_message",
    id: "42",
    parentId: "41",
    timestamp: "2026-01-01T00:01:12.000Z",
    customType: "web-search-content-ready",
    content: "Content fetched for 1/2 URLs",
    display: true,
  };
  // A later tool keeps the restored update in the middle of the group, where a
  // late append cannot land.
  const secondCall = assistant("44", "42", [{ id: "restored-custom-tail", name: "obs_recall" }]);
  const restoredEntries = [
    firstCall,
    result("41", "40", "restored-custom-tool"),
    customEntry,
    secondCall,
    result("45", "44", "restored-custom-tail"),
  ];
  await emit("session_start", {}, sessionContext(restoredEntries));
  const headTool = new ToolExecutionComponent(
    "obs_recall",
    "restored-custom-tool",
    {},
    undefined,
    { renderShell: "self", renderCall: () => new Text("recall", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  headTool.markExecutionStarted();
  headTool.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: headTool.render(80).length,
  });
  const restoredCustom = new CustomMessageComponent({
    role: "custom",
    timestamp: customEntry.timestamp,
    customType: customEntry.customType,
    content: customEntry.content,
    display: true,
  });
  const restoredCustomText = restoredCustom.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(restoredCustomText.includes("├─"), restoredCustomText);
  assert.ok(!restoredCustomText.includes("[↑ Collapse]"), restoredCustomText);
  assert.ok(restoredCustomText.includes("Web Search Content Ready"));
  assert.ok(restoredCustomText.includes("Content fetched for 1/2 URLs"));
  assert.ok(!restoredCustomText.includes("[web-search-content-ready]"));

  // The final tool continues the same tree; the synthetic collapse action is
  // its last sibling, not a disconnected divider or a persisted session entry.
  const tailTool = new ToolExecutionComponent(
    "obs_recall", "restored-custom-tail", {}, undefined,
    { renderShell: "self", renderCall: () => new Text("tail", 0, 0) },
    { requestRender() {} }, process.cwd(),
  );
  tailTool.markExecutionStarted();
  const expandedTailLines = tailTool.render(80).map(stripTerminalSequences);
  const collapseY = expandedTailLines.findIndex((line) => line.includes("[↑ Collapse]"));
  assert.ok(expandedTailLines.some((line) => line.includes("├─") && line.includes("obs_recall")), expandedTailLines.join("\n"));
  assert.equal(collapseY, expandedTailLines.length - 1);
  assert.equal(expandedTailLines[collapseY], "  └─ [↑ Collapse]");
  assert.ok(!headTool.render(80).join("\n").includes("[↑ Collapse]"));
  assert.equal(tailTool.handleMouse({
    type: "click", button: "left", x: 7, y: collapseY,
    width: 80, height: expandedTailLines.length,
  })?.handled, true);
  assert.match(headTool.render(80).map(stripTerminalSequences).join("\n"), /(?:Running|Done)\(/);
  assert.equal(tailTool.render(80).length, 0);
  assert.equal(restoredCustom.render(80).length, 0);
  // The original header remains an independent way to reopen this group.
  headTool.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: headTool.render(80).length,
  });
  assert.ok(tailTool.render(80).map(stripTerminalSequences).join("\n").includes("└─ [↑ Collapse]"));
}

// A group can be collapsed locally even after Ctrl+O expands the whole
// transcript; its sibling group remains open and the parent can reopen it.
{
  const entries = [
    assistant("46", null, [{ id: "global-first", name: "obs_recall" }]),
    result("47", "46", "global-first"),
    user("48", "47"),
    assistant("49", "48", [{ id: "global-second", name: "obs_recall" }]),
    result("50", "49", "global-second"),
  ];
  const context = sessionContext(entries);
  context.ui.getToolsExpanded = () => true;
  await emit("session_start", {}, context);
  const makeTool = (id) => {
    const tool = new ToolExecutionComponent(
      "obs_recall", id, {}, undefined,
      { renderShell: "self", renderCall: () => new Text(id, 0, 0) },
      { requestRender() {} }, process.cwd(),
    );
    tool.markExecutionStarted();
    return tool;
  };
  const first = makeTool("global-first");
  const second = makeTool("global-second");
  const firstLines = first.render(80).map(stripTerminalSequences);
  assert.equal(firstLines.at(-1), "  └─ [↑ Collapse]");
  assert.ok(second.render(80).join("\n").includes("[↑ Collapse]"));
  first.handleMouse({
    type: "click", button: "left", x: 7, y: firstLines.length - 1,
    width: 80, height: firstLines.length,
  });
  assert.ok(!first.render(80).join("\n").includes("[↑ Collapse]"));
  assert.ok(second.render(80).join("\n").includes("[↑ Collapse]"));
  first.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: first.render(80).length,
  });
  assert.ok(first.render(80).join("\n").includes("[↑ Collapse]"));
}

// While a Running group grows, move the one collapse action from the previous
// last tool to the new last tool without leaving a dangling terminal branch.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const makeTool = (id) => {
    const tool = new ToolExecutionComponent(
      "obs_recall", id, {}, undefined,
      { renderShell: "self", renderCall: () => new Text(id, 0, 0) },
      { requestRender() {} }, process.cwd(),
    );
    tool.markExecutionStarted();
    return tool;
  };
  const first = makeTool("stream-first");
  first.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: first.render(80).length,
  });
  assert.equal(first.render(80).map(stripTerminalSequences).at(-1), "  └─ [↑ Collapse]");
  const second = makeTool("stream-second");
  const oldLast = first.render(80).map(stripTerminalSequences).join("\n");
  const newLast = second.render(80).map(stripTerminalSequences);
  assert.ok(oldLast.includes("  ├─ ") && !oldLast.includes("[↑ Collapse]"), oldLast);
  assert.equal(newLast.at(-1), "  └─ [↑ Collapse]");
  for (const width of [1, 4, 8, 12]) {
    assert.ok([...first.render(width), ...second.render(width)]
      .every((line) => visibleWidth(line) <= width));
  }
}

// Live duration belongs beside Working in the editor border and uses exactly
// the same agent-start clock as the durable Completed in footer.
{
  const branch = [];
  await emit("session_start", {}, sessionContext(branch));
  const originalNow = Date.now;
  let now = 1_000;
  const indicator = {
    kind: "working",
    renderInBorder: () => "⠋ Working",
    renderSpinnerInBorder: () => "⠋",
  };
  const originalIndicatorRender = indicator.renderInBorder;
  const editor = {
    embedWorkingStatus: true,
    workingStatusIndicator: indicator,
    borderColor: (text) => `\x1b[34m${text}\x1b[39m`,
  };
  try {
    Date.now = () => now;
    await emit("agent_start");
    const border = (width = 80) => CustomEditor.prototype.renderTopBorder.call(editor, width, 0);
    assert.ok(stripTerminalSequences(border()).includes("Working 0s"));
    now += 83_000;
    const modeContext = { hasUI: true, ui: { notify() {} } };
    for (const mode of ["compact", "full", "clean"]) {
      await commands.get("pretty-tui").handler(mode, modeContext);
      assert.ok(stripTerminalSequences(border()).includes("Working 1m 23s"), mode);
      assert.ok(!stripTerminalSequences(border(17)).includes("1m 23s"), mode);
    }
    assert.ok(stripTerminalSequences(border()).includes("Working 1m 23s"));
    assert.match(border(), /\x1b\[34m 1m 23s\x1b\[39m/);
    assert.equal(indicator.renderInBorder, originalIndicatorRender, "indicator must not remain patched");
    assert.ok(!stripTerminalSequences(border(17)).includes("1m 23s"), "narrow editor drops the timer");
    const tool = new ToolExecutionComponent(
      "obs_recall", "elapsed-tool", {}, undefined,
      { renderShell: "self", renderCall: () => new Text("elapsed", 0, 0) },
      { requestRender() {} }, process.cwd(),
    );
    tool.markExecutionStarted();
    assert.ok(!tool.render(80).map(stripTerminalSequences).join("\n").includes("1m 23s"));
    await emit("agent_settled");
    assert.ok(!stripTerminalSequences(border()).includes("1m 23s"));
    assert.equal(appendedEntries.findLast((entry) => entry.type === "pretty-tui-response-footer")?.data.durationMs, 83_000);
  } finally {
    Date.now = originalNow;
  }
}

// A tool's own output text must never decide whether it failed. Pi supplies the
// authoritative flag in the render context, so output that merely starts with
// "Error:" must still render as a success.
{
  await emit("session_start", {}, sessionContext([]));
  const bashTool = tools.get("bash");
  const renderBashResult = (text, isError) => {
    const context = {
      toolCallId: "bash-output-text",
      expanded: true,
      executionStarted: true,
      state: {},
    };
    return bashTool
      .renderResult(
        { content: [{ type: "text", text }], isError },
        { expanded: true, isPartial: false },
        theme,
        { ...context, isError },
      )
      .render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  };

  const summaryOf = (rendered) =>
    rendered.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

  // Identical output text must render differently based only on Pi's flag.
  const sameText = "Error: something this tool legitimately printed";
  const asSuccess = renderBashResult(sameText, false);
  const asFailure = renderBashResult(sameText, true);
  assert.ok(summaryOf(asSuccess).includes("Done"), asSuccess);
  assert.ok(!summaryOf(asSuccess).includes("Command failed"), asSuccess);
  assert.ok(!summaryOf(asFailure).includes("Done"), asFailure);
}

// Third-party tools use their native renderer inside the same clean hierarchy,
// and thinking is a compact sibling that can be expanded independently.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const ui = { requestRender() {} };
  const thirdPartyDefinition = {
    label: "Recall Observation",
    renderShell: "self",
    renderCall: (_args, toolTheme) => new Text(toolTheme.fg("accent", "Third-party call"), 0, 0),
    renderResult: (_result, _options, toolTheme) => new Text(
      toolTheme.bg("toolSuccessBg", toolTheme.fg("toolOutput", "Money saved · Third-party result")),
      0,
      0,
    ),
  };
  const toolOnly = new ToolExecutionComponent(
    "web_search",
    "external-only",
    {},
    undefined,
    thirdPartyDefinition,
    ui,
    process.cwd(),
  );
  toolOnly.markExecutionStarted();
  const toolOnlyCollapsed = toolOnly.render(80);
  assert.ok(toolOnlyCollapsed.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("Running("));
  toolOnly.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: toolOnlyCollapsed.length,
  });
  assert.ok(toolOnly.render(80).join("\n").includes("└─"));

  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const message = {
    role: "assistant",
    timestamp: 12345,
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "Inspect compatibility\n\nPreserve native rendering" },
      { type: "toolCall", id: "external-tool", name: "obs_recall", arguments: {} },
    ],
  };
  const thinkingComponent = new AssistantMessageComponent(message);
  const toolComponent = new ToolExecutionComponent(
    "obs_recall",
    "external-tool",
    {},
    undefined,
    thirdPartyDefinition,
    ui,
    process.cwd(),
  );
  toolComponent.markExecutionStarted();
  toolComponent.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
  const nativeNotifications = [];
  const infoComponents = [];
  const notifyHost = {
    ui,
    chatContainer: { addChild(component) { infoComponents.push(component); } },
    showStatus(message) { nativeNotifications.push(["info", message]); },
    showWarning(message) { nativeNotifications.push(["warning", message]); },
    showError(message) { nativeNotifications.push(["error", message]); },
  };
  InteractiveMode.prototype.showExtensionNotify.call(notifyHost, "Footer info", "info");
  InteractiveMode.prototype.showExtensionNotify.call(notifyHost, "Default footer");
  InteractiveMode.prototype.showExtensionNotify.call(notifyHost, "Keep warning native", "warning");
  InteractiveMode.prototype.showExtensionNotify.call(notifyHost, "Keep error native", "error");
  assert.deepEqual(nativeNotifications, []);
  assert.equal(infoComponents.length, 4);
  const customMessage = {
    role: "custom",
    timestamp: 12346,
    customType: "web-search-content-ready",
    content: "Content fetched for 2/3 URLs",
    display: true,
  };
  await emit("message_start", { message: customMessage });
  const customComponent = new CustomMessageComponent(customMessage);

  const collapsedThinking = thinkingComponent.render(80);
  const collapsedTool = toolComponent.render(80);
  const collapsedThinkingText = collapsedThinking.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(collapsedThinkingText.includes("Done("), collapsedThinkingText);
  assert.ok(!collapsedThinkingText.includes("Running("), collapsedThinkingText);
  assert.ok(collapsedThinkingText.includes("1 thought"));
  assert.ok(!collapsedThinkingText.includes("Footer info"));
  assert.equal(collapsedTool.length, 0);
  assert.equal(infoComponents[0].render(80).length, 0);
  const standaloneCustom = customComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(standaloneCustom.includes("Web Search Content Ready"));
  assert.ok(standaloneCustom.includes("Content fetched for 2/3 URLs"));
  const wheelEvent = {
    type: "scroll", direction: "up", x: 1, y: 1, width: 80, height: collapsedThinking.length,
  };
  assert.equal(thinkingComponent.handleMouse(wheelEvent), undefined);
  assert.equal(toolComponent.handleMouse(wheelEvent), undefined);

  thinkingComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: collapsedThinking.length,
  });
  const compactThinking = thinkingComponent.render(80).join("\n");
  const compactTool = toolComponent.render(80).join("\n");
  const infoUpdate = infoComponents.map((component) => component.render(80).join("\n")).join("\n");
  const customUpdate = customComponent.render(80).join("\n");
  const compactThinkingText = compactThinking.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(compactThinkingText.includes("├─") && compactThinkingText.includes("● thought"));
  assert.ok(!compactThinking.includes("Inspect compatibility"));
  const compactToolText = compactTool.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const infoUpdateText = infoUpdate.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(compactToolText.includes("├─") && compactToolText.includes("● Recall Observation"));
  assert.ok(compactToolText.includes("ok"));
  assert.ok(infoUpdateText.includes("◇ Footer info"));
  assert.ok(customUpdate.includes("Web Search Content Ready"));
  assert.ok(!customUpdate.includes("[↑ Collapse]"), customUpdate);
  assert.ok(customUpdate.includes("Content fetched for 2/3 URLs"));
  assert.ok(customUpdate.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("└ Content fetched"));
  assert.ok(!/\x1b\[(?:4[0-9]|10[0-7]|48(?:;|:))/u.test(customUpdate));
  assert.ok(!compactTool.includes("Third-party call"));
  toolComponent.updateResult({ content: [{ type: "text", text: "updated result" }], isError: false });
  assert.ok(toolComponent.render(80).join("\n").includes("updated result"));

  toolComponent.handleMouse({
    type: "click", button: "left", x: 8, y: 0, width: 80, height: toolComponent.render(80).length,
  });
  const expandedTool = toolComponent.render(80).join("\n");
  const expandedToolText = expandedTool.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(expandedToolText.includes("● Recall Observation"));
  assert.ok(expandedToolText.includes("│") && expandedToolText.includes("Third-party call"));
  assert.ok(expandedTool.includes("Money saved · Third-party result"));
  assert.ok(expandedToolText.includes("└ Money saved · Third-party result"));
  assert.ok(!/\x1b\[(?:4[0-9]|10[0-7]|48(?:;|:))/u.test(expandedTool));
  toolComponent.handleMouse({
    type: "click", button: "left", x: 8, y: 0, width: 80, height: toolComponent.render(80).length,
  });
  const reCollapsedTool = toolComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(reCollapsedTool.includes("● Recall Observation"));
  assert.ok(!reCollapsedTool.includes("Third-party call"));

  const compactLines = thinkingComponent.render(80);
  thinkingComponent.handleMouse({
    type: "click", button: "left", x: 8, y: 2, width: 80, height: compactLines.length,
  });
  const fullThinking = thinkingComponent.render(80).join("\n");
  const fullThinkingText = fullThinking.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(fullThinkingText.includes("● thought"));
  assert.ok(fullThinking.includes("│") && fullThinking.includes("Preserve native rendering"));
  assert.ok(fullThinking.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("└ Preserve native rendering"));
  assert.ok(!fullThinking.includes("Thinking..."));
  thinkingComponent.handleMouse({
    type: "click", button: "left", x: 8, y: 2, width: 80, height: thinkingComponent.render(80).length,
  });
  const reCollapsedThinking = thinkingComponent.render(80).join("\n");
  assert.ok(reCollapsedThinking.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("● thought"));
  assert.ok(!reCollapsedThinking.includes("Preserve native rendering"));
  thinkingComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: thinkingComponent.render(80).length,
  });
  const reCollapsedParent = thinkingComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(reCollapsedParent, /(?:Running|Done)\(/);
  assert.ok(!reCollapsedParent.includes("● thought"));
  for (const width of [1, 4, 8, 12]) {
    const lines = [
      ...thinkingComponent.render(width),
      ...toolComponent.render(width),
      ...infoComponents.flatMap((component) => component.render(width)),
      ...customComponent.render(width),
    ];
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
}

// A same-named third-party tool may also provide a self-framed renderer.
// It must still use the third-party activity projection and keep its renderer.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const native = {
    label: "external bash", renderShell: "self",
    renderCall: () => new Text("external bash details", 0, 0),
    renderResult: () => new Text("external bash output", 0, 0),
  };
  // A built-in extension can also own a replacement tool; its source label is
  // "builtin", but its path is not the built-in bash tool's path.
  pi.getAllTools = () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:external-extension" } }];
  const resolve = (index) => index < toolResolvers.length
    ? toolResolvers[index]("bash", () => resolve(index + 1)) : native;
  const tool = new ToolExecutionComponent(
    "bash", "self-framed-external", { command: "run" }, undefined,
    resolve(0), { requestRender() {} }, process.cwd(),
  );
  tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
  tool.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: tool.render(80).length });
  const lines = tool.render(80).map(stripTerminalSequences);
  assert.ok(lines.some((line) => line.includes("● external bash")), lines.join("\n"));
  assert.ok(!lines.join("\n").includes("external bash details"));
  const childY = lines.findIndex((line) => line.includes("● external bash"));
  tool.handleMouse({ type: "click", button: "left", x: 8, y: childY, width: 80, height: lines.length });
  assert.ok(tool.render(80).map(stripTerminalSequences).join("\n").includes("external bash details"));
  pi.getAllTools = () => [];
}

// FFF can override the built-in names grep/find with default-shell renderers.
// A tool's name alone must not cause its boxed renderer to leak into the
// compact activity tree; clicking the child still exposes native details.
for (const name of ["find", "grep"]) {
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const tool = new ToolExecutionComponent(
    name, `fff-${name}`, { pattern: "release", path: "src/" }, undefined,
    {
      label: name,
      renderCall: (_args, toolTheme) => new Text(toolTheme.fg("accent", `Native boxed ${name}`), 0, 0),
      renderResult: () => new Text(`Native ${name} results`, 0, 0),
    },
    { requestRender() {} }, process.cwd(),
  );
  tool.markExecutionStarted();
  tool.updateResult({ content: [{ type: "text", text: `${name} match` }], isError: false });
  tool.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: tool.render(80).length,
  });
  const compactLines = tool.render(80).map(stripTerminalSequences);
  assert.ok(compactLines.some((line) => line.includes(`├─ ● ${name}`)), compactLines.join("\n"));
  assert.ok(!compactLines.join("\n").includes(`Native boxed ${name}`));
  assert.equal(compactLines.at(-1), "  └─ [↑ Collapse]");
  const childY = compactLines.findIndex((line) => line.includes(`● ${name}`));
  tool.handleMouse({ type: "click", button: "left", x: 8, y: childY, width: 80, height: compactLines.length });
  assert.ok(tool.render(80).map(stripTerminalSequences).join("\n").includes(`Native boxed ${name}`));
}

// A failed attempt can leave its Thinking block outside its completed activity
// group while an automatic retry places a different Thought inside the next
// group. Failed-attempt thinking must retain timeline ownership instead of
// becoming a standalone native block between the two groups.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const failedAttemptThinking = "Implementing Markdown render helper\n\nAdding markdown cache invalidation";
  const retryAttemptThinking = "Implementing Markdown component caching\n\nRefining Markdown rendering";
  const firstAttempt = {
    role: "assistant",
    timestamp: 55_000,
    content: [
      { type: "thinking", thinking: failedAttemptThinking },
      { type: "toolCall", id: "failed-attempt-tool", name: "edit", arguments: { path: "x.ts" } },
    ],
  };
  await emit("message_update", { message: firstAttempt });
  const failedThinking = new AssistantMessageComponent(firstAttempt);
  const failedTool = new ToolExecutionComponent(
    "edit",
    "failed-attempt-tool",
    { path: "x.ts" },
    undefined,
    { renderShell: "self", renderCall: () => new Text("edit x.ts", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  failedTool.markExecutionStarted();
  const failedMessage = {
    ...firstAttempt,
    stopReason: "error",
    errorMessage: "WebSocket error",
  };
  failedThinking.updateContent(failedMessage, false);
  failedTool.updateResult({
    content: [{ type: "text", text: "WebSocket error" }],
    isError: true,
  });
  await emit("message_end", { message: failedMessage });
  await emit("agent_settled");

  await emit("agent_start");
  const retryAttempt = {
    role: "assistant",
    timestamp: 56_000,
    content: [
      { type: "thinking", thinking: retryAttemptThinking },
      { type: "toolCall", id: "retry-attempt-tool", name: "edit", arguments: { path: "x.ts" } },
    ],
  };
  await emit("message_update", { message: retryAttempt });
  const retryThinking = new AssistantMessageComponent(retryAttempt);
  const retryTool = new ToolExecutionComponent(
    "edit",
    "retry-attempt-tool",
    { path: "x.ts" },
    undefined,
    { renderShell: "self", renderCall: () => new Text("edit x.ts", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  retryTool.markExecutionStarted();
  const retryCollapsed = retryThinking.render(80);
  retryThinking.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: retryCollapsed.length,
  });
  retryThinking.handleMouse({
    type: "click", button: "left", x: 8, y: 2, width: 80, height: retryThinking.render(80).length,
  });

  const failedRendered = [
    ...failedThinking.render(80),
    ...failedTool.render(80),
  ].join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const retryRendered = [
    ...retryThinking.render(80),
    ...retryTool.render(80),
  ].join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(!failedRendered.includes("Implementing Markdown render helper"));
  assert.ok(failedRendered.includes("Done("), failedRendered);
  assert.ok(!failedRendered.includes("Running("), failedRendered);
  assert.ok(retryRendered.includes("Implementing Markdown component caching"));
}

// Pure assistant terminal states with no tool remain visible as unified
// severity updates rather than falling back to Pi's unrelated native block.
{
  for (const fixture of [
    { stopReason: "error", errorMessage: "Authentication failed", expected: "Error" },
    { stopReason: "aborted", errorMessage: "Cancelled by operator", expected: "Operation aborted" },
    { stopReason: "length", errorMessage: "", expected: "Response truncated" },
  ]) {
    await emit("session_start", {}, sessionContext([]));
    const terminalMessage = {
      role: "assistant",
      timestamp: `terminal-${fixture.stopReason}`,
      content: [],
      stopReason: fixture.stopReason,
      errorMessage: fixture.errorMessage,
    };
    await emit("message_end", { message: terminalMessage });
    const terminalComponent = new AssistantMessageComponent(terminalMessage);
    const terminalText = terminalComponent.render(80).join("\n")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    assert.ok(terminalText.includes(fixture.expected));
    assert.ok(terminalText.includes(fixture.errorMessage || "Response was truncated before completion."));
  }
}

// Repeated pure assistant failures and Pi's final retry failure remain five
// standalone hard-boundary errors; they never form Updates/Failed groups.
{
  await emit("session_start", {}, sessionContext([]));
  const retryErrorComponents = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const failedAttempt = {
      role: "assistant",
      timestamp: `network-error-${attempt}`,
      content: [],
      stopReason: "error",
      errorMessage: "fetch failed",
    };
    await emit("message_end", { message: failedAttempt });
    const component = new AssistantMessageComponent(failedAttempt);
    component.render(80);
    retryErrorComponents.push(component);
  }
  const runtimeErrorComponents = [];
  InteractiveMode.prototype.showError.call({
    ui: { requestRender() {} },
    chatContainer: { addChild(component) { runtimeErrorComponents.push(component); } },
  }, "Retry failed after 3 attempts: fetch failed");
  const renderedErrors = [
    ...retryErrorComponents.flatMap((component) => component.render(80)),
    ...runtimeErrorComponents.flatMap((component) => component.render(80)),
  ].join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // Alerts stay standalone: each renders its own card, and no group-parent row
  // (the `●` marker) appears for them. This fails if update-only folding or a
  // parent-row projection is ever reintroduced.
  assert.equal(renderedErrors.split("✕").length - 1, 5, renderedErrors);
  assert.ok(!renderedErrors.includes("● "), renderedErrors);
  assert.equal(renderedErrors.split("fetch failed").length - 1, 5, renderedErrors);
  assert.ok(renderedErrors.includes("Retry failed after 3 attempts"));
}

// Adjacent identical errors are visual runs only; full payload/source/type
// identity matters, and any intervening component terminates the run.
{
  await emit("session_start", {}, sessionContext([]));
  const children = [];
  const host = {
    ui: { requestRender() {} },
    chatContainer: { children, addChild(component) { children.push(component); } },
  };
  const show = (text) => InteractiveMode.prototype.showError.call(host, text);
  const plain = (width = 100) => children.flatMap((component) => component.render(width)).map(stripTerminalSequences).join("\n");
  show("Error\nWebSocket error");
  show("Error\nfetch failed");
  show("Error\nfetch failed");
  assert.match(plain(), /✕ Error · WebSocket error\n✕ Error · fetch failed ×2/);
  assert.deepEqual(children[2].render(100), []);
  show("Error\nfetch failed");
  assert.match(plain(), /fetch failed ×3/);
  children.push(new Text("A message boundary", 0, 0));
  show("Error\nfetch failed");
  assert.equal((plain().match(/fetch failed/g) ?? []).length, 2);
  show("Error\nfetch failed\nSecond line differs");
  assert.match(plain(), /Second line differs/);
  assert.ok(!plain().includes("×4"));
  show("Different title\nfetch failed");
  assert.match(plain(), /Different title · fetch failed/);

  const rawMessage = { role: "assistant", timestamp: "compact-error-1", stopReason: "error", errorMessage: "fetch failed", content: [] };
  const rawBefore = JSON.stringify(rawMessage);
  const first = new AssistantMessageComponent(rawMessage);
  const secondMessage = { ...rawMessage, timestamp: "compact-error-2" };
  const second = new AssistantMessageComponent(secondMessage);
  const third = new AssistantMessageComponent({ ...rawMessage, timestamp: "compact-error-3" });
  children.push(first, second, third);
  assert.match(plain(), /✕ Error · fetch failed ×3/);
  assert.deepEqual(second.render(100), []);
  assert.deepEqual(third.render(100), []);
  assert.equal(JSON.stringify(rawMessage), rawBefore);
  // Same title/body but runtime and assistant failures are distinct types.
  show("Error\nfetch failed");
  assert.ok(children.at(-1).render(100).length > 0);
  assert.ok(!plain().includes("×4"));
  const multiline = "same first line\n  exact indentation\n" + "FULL_ERROR_DETAIL ".repeat(12);
  show("Error\n" + multiline);
  show("Error\n" + multiline);
  const lines = children.at(-2).render(30).map(stripTerminalSequences);
  assert.ok(lines.every((line) => visibleWidth(line) <= 30));
  assert.match(lines.join("\n"), /×2/);
  assert.equal((lines.join("").match(/FULL_ERROR_DETAIL/g) ?? []).length, 12);
  assert.ok(!lines.join("\n").includes("…"));
  // Rebuild the same pure assistant sequence without relying on render order.
  const restored = [first, second, third].map((component, index) => new AssistantMessageComponent({ ...rawMessage, timestamp: `restored-error-${index}` }));
  children.splice(0, children.length, ...restored);
  restored[2].render(100); // suppressed even when it renders before its owner
  assert.match(plain(), /✕ Error · fetch failed ×3/);
  assert.equal(children.length, 3, "UI folding must not remove original components");
  const commandContext = { hasUI: true, ui: { notify() {} } };
  await commands.get("pretty-tui").handler("full", commandContext);
  assert.equal(plain().split("fetch failed").length - 1, 3);
  await commands.get("pretty-tui").handler("clean", commandContext);
  assert.match(plain(), /fetch failed ×3/);
}

// Regression: while the current group holds only a thought, a notification and
// a renderer-less custom message still join that group. Both used to fall into
// the tool-only refusal branch, which threw inside ctx.ui.notify and left the
// custom message on Pi's native purple box.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const thoughtOnlyMessage = {
    role: "assistant",
    timestamp: 58_000,
    content: [{ type: "thinking", thinking: "Only a thought so far" }],
  };
  await emit("message_update", { message: thoughtOnlyMessage });
  const thoughtOnlyThinking = new AssistantMessageComponent(thoughtOnlyMessage);
  const thoughtOnlyChildren = [];
  const thoughtOnlyHost = {
    ui: { requestRender() {} },
    chatContainer: { addChild(component) { thoughtOnlyChildren.push(component); } },
  };
  assert.doesNotThrow(() => {
    InteractiveMode.prototype.showExtensionNotify.call(thoughtOnlyHost, "Indexing complete", "info");
  });
  assert.equal(thoughtOnlyChildren.length, 1);
  const thoughtOnlyCustom = new CustomMessageComponent({
    role: "custom",
    timestamp: 58_100,
    customType: "plugin-event",
    content: "Renderer-less **markdown** payload",
    display: true,
  });
  const renderThoughtOnly = () => [
    ...thoughtOnlyThinking.render(80),
    ...thoughtOnlyChildren.flatMap((component) => component.render(80)),
    ...thoughtOnlyCustom.render(80),
  ].join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  // Collapsed: the tool-free turn still gets a parent row, and its members are
  // hidden inside it exactly like tool members.
  const collapsedThoughtOnly = renderThoughtOnly();
  assert.ok(collapsedThoughtOnly.includes("Running(1 thought"), collapsedThoughtOnly);
  assert.ok(!collapsedThoughtOnly.includes("Indexing complete"));
  assert.ok(!collapsedThoughtOnly.includes("Plugin Event"));

  thoughtOnlyThinking.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80,
    height: thoughtOnlyThinking.render(80).length,
  });
  const revealedThoughtOnly = renderThoughtOnly();
  assert.ok(revealedThoughtOnly.includes("● thought"));
  assert.ok(revealedThoughtOnly.includes("Indexing complete"), revealedThoughtOnly);
  assert.ok(!revealedThoughtOnly.includes("[plugin-event]"), revealedThoughtOnly);
  assert.ok(revealedThoughtOnly.includes("Plugin Event"));
  assert.ok(revealedThoughtOnly.includes("Renderer-less"));
  assert.ok(!revealedThoughtOnly.includes("**"));
  const customLines = thoughtOnlyCustom.render(80).map(stripTerminalSequences);
  assert.equal(customLines.at(-1), "  └─ [↑ Collapse]");
  assert.ok(customLines.some((line) => line.startsWith("  ├─ ") && line.includes("Plugin Event")));
  assert.equal(thoughtOnlyCustom.handleMouse({
    type: "click", button: "left", x: 7, y: customLines.length - 1,
    width: 80, height: customLines.length,
  })?.handled, true);
  assert.ok(!renderThoughtOnly().includes("Plugin Event"));
  assert.ok(!renderThoughtOnly().includes("Indexing complete"));
}

// Regression: a turn that produces a thought and no tool call still gets the
// unified parent row, with the Thought as its child. The native component no
// longer holds the Thinking content, so this projection is the only renderer.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const thinkingOnly = {
    role: "assistant",
    timestamp: 58_200,
    stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "Thought that must survive" }],
  };
  await emit("message_update", { message: thinkingOnly });
  const turnComponent = new AssistantMessageComponent(thinkingOnly);
  const renderTurn = () => turnComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  // Streaming a Thought with no tool yet is a live group, so it reads Running.
  const runningTurn = renderTurn();
  assert.ok(runningTurn.includes("● Running(1 thought)"), runningTurn);
  assert.ok(!runningTurn.includes("tool call"));

  // The same message then gains visible text and settles as Done.
  const thoughtOnlyTurn = {
    ...thinkingOnly,
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "Thought that must survive" },
      { type: "text", text: "Final answer text" },
    ],
  };
  turnComponent.updateContent(thoughtOnlyTurn);
  await emit("message_update", { message: thoughtOnlyTurn });
  await emit("message_end", { message: thoughtOnlyTurn });
  const doneTurn = renderTurn();
  assert.ok(doneTurn.includes("● Done(1 thought)"), doneTurn);
  assert.ok(doneTurn.includes("Final answer text"));
  assert.ok(!doneTurn.includes("Thought that must survive"));

  turnComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: turnComponent.render(80).length,
  });
  const revealedTurn = renderTurn();
  assert.ok(revealedTurn.includes("├─ ● thought"), revealedTurn);
  assert.ok(revealedTurn.includes("└─ [↑ Collapse]"), revealedTurn);
  assert.ok(revealedTurn.includes("Final answer text"));
  assert.ok(!revealedTurn.includes("Thought that must survive"));

  turnComponent.handleMouse({
    type: "click", button: "left", x: 4, y: 2, width: 80, height: turnComponent.render(80).length,
  });
  const expandedTurn = renderTurn();
  assert.ok(expandedTurn.includes("Thought that must survive"), expandedTurn);
  assert.ok(expandedTurn.includes("Final answer text"));
  const turnLines = turnComponent.render(80).map(stripTerminalSequences);
  const turnCollapseY = turnLines.findIndex((line) => line.includes("[↑ Collapse]"));
  assert.ok(turnCollapseY >= 0 && turnCollapseY < turnLines.findIndex((line) => line.includes("Final answer text")));
  assert.equal(turnComponent.handleMouse({
    type: "click", button: "left", x: 7, y: turnCollapseY,
    width: 80, height: turnLines.length,
  })?.handled, true);
  assert.ok(!renderTurn().includes("Thought that must survive"));
  assert.ok(!renderTurn().includes("[↑ Collapse]"));
  assert.ok(renderTurn().includes("Final answer text"));

  // A thought with neither tool calls nor visible text must still render.
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const bareThought = {
    role: "assistant",
    timestamp: 58_300,
    stopReason: "stop",
    content: [{ type: "thinking", thinking: "Bare thought" }],
  };
  const bareComponent = new AssistantMessageComponent(bareThought);
  const bareText = bareComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(bareText.includes("● Running(1 thought)"), bareText);
}


// Clean mode owns thought disclosure. Ctrl+T is intercepted without changing
// Pi's persisted hideThinkingBlock setting, while non-clean modes still use
// Pi's original toggle implementation.
{
  widgets.clear();
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const visibilityMessage = {
    role: "assistant",
    timestamp: 56_500,
    content: [
      { type: "thinking", thinking: "Individually expanded thought detail" },
      { type: "toolCall", id: "visibility-tool", name: "edit", arguments: { path: "visible.ts" } },
    ],
  };
  await emit("message_update", { message: visibilityMessage });
  const visibilityThinking = new AssistantMessageComponent(visibilityMessage);
  const visibilityTool = new ToolExecutionComponent(
    "edit", "visibility-tool", { path: "visible.ts" }, undefined,
    { renderShell: "self", renderCall: () => new Text("edit visible.ts", 0, 0) },
    { requestRender() {} }, process.cwd(),
  );
  visibilityTool.markExecutionStarted();
  visibilityThinking.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80,
    height: visibilityThinking.render(80).length,
  });
  const renderVisibilityThinking = () => visibilityThinking.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const revealedThought = renderVisibilityThinking();
  assert.ok(revealedThought.includes("● thought"), revealedThought);
  assert.ok(!revealedThought.includes("Individually expanded thought detail"), revealedThought);

  // Even a native visibility refresh with Pi's setting at "visible" must not
  // bypass clean mode's per-thought disclosure.
  InteractiveMode.prototype.updateThinkingBlockVisibility.call({
    hideThinkingBlock: false,
    chatContainer: { children: [visibilityThinking] },
    ui: { requestRender() {} },
  });
  assert.ok(!renderVisibilityThinking().includes("Individually expanded thought detail"));

  let settingWrites = 0;
  let nativeVisibilityUpdates = 0;
  const visibilityHost = {
    hideThinkingBlock: false,
    settingsManager: { setHideThinkingBlock() { settingWrites += 1; } },
    updateThinkingBlockVisibility() { nativeVisibilityUpdates += 1; },
    showStatus: InteractiveMode.prototype.showStatus,
    ui: { requestRender() {} },
  };
  InteractiveMode.prototype.toggleThinkingBlockVisibility.call(visibilityHost);
  assert.equal(visibilityHost.hideThinkingBlock, false);
  assert.equal(settingWrites, 0);
  assert.equal(nativeVisibilityUpdates, 0);
  assert.ok(widgetText().includes("Thought details expand individually in clean mode"), widgetText());
  assert.ok(!renderVisibilityThinking().includes("Individually expanded thought detail"));

  mouseGestureFixture(visibilityThinking, visibilityThinking.render(80), 80).gesture(4, 2, [[-2, 0]]);
  assert.ok(renderVisibilityThinking().includes("Individually expanded thought detail"));

  // Ctrl+O is also advisory in clean mode, without invoking the expansion API.
  const expansionRequests = [];
  const keyboardHost = {
    toolOutputExpanded: false,
    setToolsExpanded(value) { expansionRequests.push(value); this.toolOutputExpanded = value; },
    showStatus: InteractiveMode.prototype.showStatus,
  };
  const beforeKeyboardToggle = renderVisibilityThinking();
  for (const expanded of [false, true]) {
    keyboardHost.toolOutputExpanded = expanded;
    InteractiveMode.prototype.toggleToolOutputExpansion.call(keyboardHost);
    assert.equal(keyboardHost.toolOutputExpanded, expanded);
    assert.deepEqual(expansionRequests, []);
    assert.equal(renderVisibilityThinking(), beforeKeyboardToggle);
    assert.ok(widgetText().includes("Activity details expand individually in clean mode"));
  }
  assert.ok(!widgetText().includes("Ctrl+O"));

  // Full/compact modes delegate to Pi unchanged, including persistence.
  const commandContext = { hasUI: true, ui: { notify() {} } };
  await commands.get("pretty-tui").handler("full", commandContext);
  let nativeStatus = "";
  visibilityHost.showStatus = (message) => { nativeStatus = message; };
  InteractiveMode.prototype.toggleThinkingBlockVisibility.call(visibilityHost);
  assert.equal(visibilityHost.hideThinkingBlock, true);
  assert.equal(settingWrites, 1);
  assert.equal(nativeVisibilityUpdates, 1);
  assert.equal(nativeStatus, "Thinking blocks: hidden");
  keyboardHost.toolOutputExpanded = false;
  InteractiveMode.prototype.toggleToolOutputExpansion.call(keyboardHost);
  assert.deepEqual(expansionRequests, [true]);
  await commands.get("pretty-tui").handler("compact", commandContext);
  InteractiveMode.prototype.toggleToolOutputExpansion.call(keyboardHost);
  assert.deepEqual(expansionRequests, [true, false]);
  await commands.get("pretty-tui").handler("clean", commandContext);
}

// The editor-adjacent widget is a ten-second UI flash. Thinking, tools,
// extension notifications, warnings, and errors never occupy it; direct Pi
// showStatus calls replace one another without entering the transcript.
{
  widgets.clear();
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const widgetMessage = {
    role: "assistant",
    timestamp: 57_000,
    content: [
      { type: "thinking", thinking: "Inspect widget lifecycle" },
      { type: "toolCall", id: "widget-tool", name: "edit", arguments: { path: "widget.ts" } },
    ],
  };
  // An empty reading must mean "no widget installed", not "installed but blank",
  // otherwise these checks would pass even if the flash never worked.
  const assertNoFlash = (label) => {
    assert.equal(widgets.has("pretty-tui-latest-activity"), false, label);
    assert.equal(widgetText(), "", label);
  };
  await emit("message_update", { message: widgetMessage });
  assertNoFlash("thinking must not feed the flash");
  await emit("tool_execution_start", {
    toolCallId: "widget-tool", toolName: "edit", args: { path: "widget.ts" },
  });
  assertNoFlash("a running tool must not feed the flash");
  await emit("tool_execution_end", {
    toolCallId: "widget-tool",
    toolName: "edit",
    result: { content: [{ type: "text", text: "Edit failed" }] },
    isError: true,
  });
  assertNoFlash("a failed tool must not feed the flash");
  await emit("message_end", {
    message: { ...widgetMessage, stopReason: "error", errorMessage: "WebSocket error" },
  });
  assertNoFlash("an assistant error must not feed the flash");

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  let timerId = 0;
  globalThis.setTimeout = (callback, delay) => {
    timerId += 1;
    scheduled.push({ id: timerId, callback, delay });
    return timerId;
  };
  globalThis.clearTimeout = () => {};
  try {
    const statusComponents = [];
    const statusHost = {
      ui: { requestRender() {} },
      chatContainer: { addChild(component) { statusComponents.push(component); } },
    };
    InteractiveMode.prototype.showStatus.call(statusHost, "Thinking blocks: hidden");
    InteractiveMode.prototype.showStatus.call(statusHost, "Thinking blocks: visible");
    assert.equal(statusComponents.length, 0, "showStatus must stay out of the transcript");
    assert.ok(widgetText().includes("Thinking blocks: visible"));
    assert.ok(!widgetText().includes("Thinking blocks: hidden"));
    assert.equal(scheduled.length, 2, "each status schedules its own expiry");
    assert.equal(scheduled.at(-1).delay, 10_000);

    // The superseded timer must not clear the newer status, which is the whole
    // reason the widget tracks a generation.
    scheduled[0].callback();
    assert.ok(widgetText().includes("Thinking blocks: visible"), "a stale timer cleared a live status");

    await emit("message_start", {
      message: { role: "user", content: [{ type: "text", text: "next" }] },
    });
    assert.ok(widgetText().includes("Thinking blocks: visible"), "model work must not clear the flash");
    scheduled.at(-1).callback();
    assertNoFlash("the newest timer clears the flash");

    InteractiveMode.prototype.showStatus.call(statusHost, "Reload status");
    assert.ok(widgetText().includes("Reload status"));
    await emit("session_start", {}, sessionContext([]));
    assertNoFlash("session_start clears the flash");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

// Clean mode owns all runtime notification severities. Warning and error
// updates retain distinct theme styling instead of falling back to Pi's native
// chat lines.
{
  await emit("session_start", {}, sessionContext([]));
  const nativeNotifications = [];
  const components = [];
  const host = {
    ui: { requestRender() {} },
    chatContainer: { addChild(component) { components.push(component); } },
    showStatus(message) { nativeNotifications.push(["info", message]); },
    showWarning(message) { nativeNotifications.push(["warning", message]); },
    showError(message) { nativeNotifications.push(["error", message]); },
  };
  InteractiveMode.prototype.showExtensionNotify.call(host, "Rate limit approaching", "warning");
  InteractiveMode.prototype.showExtensionNotify.call(host, "WebSocket failed", "error");
  assert.deepEqual(nativeNotifications, []);
  assert.equal(widgets.has("pretty-tui-latest-activity"), false);
  const warningLines = components[0].render(80).join("\n");
  const errorLines = components[1].render(80).join("\n");
  assert.ok(warningLines.includes("Rate limit approaching"));
  assert.ok(errorLines.includes("WebSocket failed"));
  const warningColor = warningLines.match(/\x1b\[[0-9;]+m/)?.[0];
  const errorColor = errorLines.match(/\x1b\[[0-9;]+m/)?.[0];
  assert.ok(warningColor && errorColor);
  assert.notEqual(warningColor, errorColor);
}

// Shared thoughts and notifications keep their content through mode switches.
{
  const commandContext = { hasUI: true, ui: { notify() {} } };
  const render = (component, width = 100) => component.render(width).map(stripTerminalSequences);
  for (const mode of ["clean", "compact", "full"]) {
    await commands.get("pretty-tui").handler(mode, commandContext);
    await emit("session_start", {}, sessionContext([]));
    await emit("agent_start");
    const message = { role: "assistant", timestamp: `shared-thought-${mode}`, content: [{ type: "text", text: "VISIBLE_ANSWER" }] };
    await emit("message_update", { message });
    const component = new AssistantMessageComponent(message);
    const complete = { ...message, content: [
      { type: "thinking", thinking: "SHARED_THOUGHT_PREVIEW\nSHARED_THOUGHT_DETAIL\n\n- 思考详情" }, ...message.content,
    ] };
    await emit("message_update", { message: complete });
    component.updateContent(complete, false);
    let rows = render(component);
    if (mode === "clean") {
      component.handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 100, height: rows.length });
      rows = render(component);
    }
    assert.ok(rows.join("\n").includes(mode !== "clean" ? "╭─ thought" : "● thought"), mode);
    assert.ok(rows.join("\n").includes("VISIBLE_ANSWER"));
    assert.equal(rows.join("\n").includes("SHARED_THOUGHT_DETAIL"), mode === "full");
    const y = rows.findIndex((line) => line.includes(mode !== "clean" ? "╭─ thought" : "● thought"));
    mouseGestureFixture(component, rows, 100).gesture(6, y, [[2, 0]]);
    assert.equal(render(component).join("\n").includes("SHARED_THOUGHT_DETAIL"), mode !== "full");
    assert.equal(render(component).filter((line) => line.includes("VISIBLE_ANSWER")).length, 1);
    if (mode !== "clean") {
      component.setHideThinkingBlock(true);
      assert.ok(!render(component).join("\n").includes("SHARED_THOUGHT_DETAIL"));
      component.setHideThinkingBlock(false);
      assert.ok(render(component).join("\n").includes("SHARED_THOUGHT_DETAIL"));
      for (const width of (mode === "full" ? [12, 40] : [1, 12, 40])) assert.ok(render(component, width).every((line) => visibleWidth(line) <= width));
    }
    const host = { ui: { requestRender() {} }, chatContainer: { children: [], addChild(child) { this.children.push(child); } } };
    InteractiveMode.prototype.showStatus.call(host, "Shared UI status");
    const statusText = () => mode === "full" ? host.chatContainer.children.flatMap((child) => render(child)).join("\n") : widgetText();
    assert.ok(statusText().includes("Shared UI status"));
    for (const target of ["full", "compact", "clean", mode]) {
      await commands.get("pretty-tui").handler(target, commandContext);
      assert.ok(statusText().includes("Shared UI status"), "switching modes must not clear feedback");
      const switched = render(component).join("\n");
      assert.equal(switched.split("VISIBLE_ANSWER").length - 1, 1, target);
      if (target !== "clean") assert.ok(switched.includes(target !== "clean" ? "╭─ thought" : "● thought"), target);
    }
    for (const severity of ["info", "warning", "error", "error"]) {
      InteractiveMode.prototype.showExtensionNotify.call(host, severity === "error" ? "Error\nSHARED_ERROR" : `${severity} notice\nSHARED_NOTICE_DETAIL`, severity);
    }
    const all = () => host.chatContainer.children.flatMap((child) => render(child)).join("\n");
    assert.match(all(), mode === "full" ? /info notice/ : /◇ info notice/);
    assert.match(all(), mode === "full" ? /Warning: warning notice/ : /⚠ warning notice/);
    if (mode === "full") assert.equal(all().split("SHARED_ERROR").length - 1, 2);
    else assert.match(all(), /✕ Error · SHARED_ERROR ×2/);
    assert.ok(all().includes("SHARED_NOTICE_DETAIL"));
    assert.ok(!widgetText().includes("SHARED_ERROR"));
    for (const target of ["compact", "full", "clean"]) {
      await commands.get("pretty-tui").handler(target, commandContext);
      if (target === "full" || mode === "full") assert.equal(all().split("SHARED_ERROR").length - 1, 2);
      else assert.match(all(), /SHARED_ERROR ×2/);
    }
    await commands.get("pretty-tui").handler(mode, commandContext);
    const custom = new CustomMessageComponent({ role: "custom", customType: "shared-update", content: "CUSTOM_SHARED_DETAIL", display: true, timestamp: `${mode}-custom` });
    assert.match(render(custom).join("\n"), /CUSTOM_SHARED_DETAIL/);
    // A partial answer and its terminal failure are both retained exactly once.
    const failed = new AssistantMessageComponent({ role: "assistant", timestamp: `${mode}-failed`, stopReason: "error", errorMessage: "SHARED_TERMINAL_ERROR", content: [{ type: "text", text: "PARTIAL_SHARED_ANSWER" }] });
    const failureRows = render(failed).join("\n");
    assert.equal(failureRows.split("SHARED_TERMINAL_ERROR").length - 1, 1);
    assert.ok(failureRows.includes("PARTIAL_SHARED_ANSWER"));
    for (const stopReason of ["aborted", "length"]) {
      const stopped = new AssistantMessageComponent({ role: "assistant", timestamp: `${mode}-${stopReason}`, stopReason,
        errorMessage: `SHARED_${stopReason}`, content: [{ type: "text", text: "STOPPED_ANSWER" }] });
      const stoppedRows = render(stopped).join("\n");
      assert.ok(mode === "full" ? stoppedRows.includes(stopReason === "aborted" ? "SHARED_aborted" : "Response was truncated") : stoppedRows.includes(stopReason === "aborted" ? "⚠ Operation aborted" : "✕ Response truncated"));
      assert.equal(stoppedRows.split(`SHARED_${stopReason}`).length - 1, mode === "full" && stopReason === "length" ? 0 : 1);
      assert.ok(stoppedRows.includes("STOPPED_ANSWER"));
    }
    await emit("agent_settled");
  }
  await commands.get("pretty-tui").handler("clean", commandContext);
}

// Only the Running parent dot pulses; its label and settled dot stay stable.
{
  const pulseColors = [];
  const pulseContext = sessionContext([]);
  pulseContext.ui.theme = {
    ...theme,
    fg(color, text) { pulseColors.push([text, color]); return text; },
  };
  await emit("session_start", {}, pulseContext);
  let borderRole = "input-border";
  const pulseEditor = {
    borderColor(text) { pulseColors.push([text, borderRole]); return text; },
  };
  CustomEditor.prototype.renderTopBorder.call(pulseEditor, 80, 0);
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    await emit("agent_start", {}, pulseContext);
    const message = {
      role: "assistant", timestamp: 10_000, stopReason: "toolUse",
      content: [{ type: "thinking", thinking: "Pulse fixture" }],
    };
    await emit("message_update", { message }, pulseContext);
    const component = new AssistantMessageComponent(message);
    const checkPhase = (dotColor) => {
      pulseColors.length = 0;
      const rows = component.render(80).map(stripTerminalSequences);
      assert.ok(rows.join("\n").includes("● Running(1 thought)"));
      assert.ok(pulseColors.some(([text, color]) => text === "● " && color === dotColor));
      assert.ok(pulseColors.some(([text, color]) => text === "Running" && color === borderRole));
      return rows;
    };
    const initial = checkPhase(borderRole);
    now += 800;
    assert.deepEqual(checkPhase("dim"), initial, "pulse must not shift the layout");
    now += 800;
    borderRole = "changed-input-border";
    checkPhase(borderRole); // Changes to the live editor border are reflected immediately.
    await emit("agent_settled", {}, pulseContext);
    const settled = () => component.render(80).map(stripTerminalSequences);
    pulseColors.length = 0;
    const done = settled();
    assert.ok(done.join("\n").includes("Done(1 thought)"));
    for (const text of ["● ", "Done", "1 thought"]) {
      assert.ok(pulseColors.some(([value, color]) => value === text && color === "dim"), text);
    }
    now += 800;
    assert.deepEqual(settled(), done);
    component.handleMouse({ type: "click", button: "left", x: 4, y: 1, width: 80, height: done.length });
    pulseColors.length = 0;
    settled();
    assert.ok(pulseColors.some(([text, color]) => text === "Done" && color === "success"));
    assert.ok(pulseColors.some(([text, color]) => text === "● " && color === "success"));
  } finally {
    Date.now = originalNow;
    await emit("session_start", {}, sessionContext([]));
  }
}

// A settled agent turn gets a durable completion footer. Duration spans the
// whole run, Copy includes only the final visible answer, and reload restores
// the answer association without duplicating the text in footer data.
{
  appendedEntries.length = 0;
  const footerBranch = [];
  const footerContext = sessionContext(footerBranch);
  footerContext.sessionManager.getBranch = () => footerBranch;
  await emit("session_start", {}, footerContext);
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    await emit("agent_start");
    now = 30_000;
    await emit("agent_end");
    now = 31_000;
    await emit("agent_start");
    const finalAnswer = {
      role: "assistant",
      timestamp: 70_000,
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Private reasoning is not copied" },
        { type: "text", text: "Final answer, first block." },
        { type: "text", text: "Second block." },
      ],
    };
    await emit("message_end", { message: finalAnswer });
    // A later message_end extension can replace the answer before Pi persists
    // it. Only the committed message may be copied by the footer.
    footerBranch.push({
      id: "footer-answer",
      parentId: null,
      type: "message",
      message: {
        ...finalAnswer,
        content: [
          { type: "text", text: "Published answer, first block." },
          { type: "text", text: "Second block." },
        ],
      },
    });
    now = 66_000;
    await emit("agent_settled", {}, footerContext);
    await emit("agent_settled", {}, footerContext);
  } finally {
    Date.now = originalNow;
  }

  const footerEntries = appendedEntries.filter((entry) => entry.type === "pretty-tui-response-footer");
  assert.equal(footerEntries.length, 1);
  const footerEntry = footerEntries[0];
  assert.deepEqual(footerEntry.data, {
    answerEntryId: "footer-answer",
    durationMs: 65_000,
    outcome: "completed",
  });
  assert.equal("answer" in footerEntry.data, false);

  const nativeCopies = [];
  const fullscreenUi = {
    mode: "fullscreen",
    async copyTextToClipboard(text) {
      nativeCopies.push(text);
      return true;
    },
  };
  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: fullscreenUi }, []);
  } catch {}
  const footerRenderer = entryRenderers.get("pretty-tui-response-footer");
  assert.ok(footerRenderer);
  const renderFooter = (entry = footerEntry, width = 80) => {
    const component = footerRenderer(
      { id: "footer-test", type: "custom", customType: entry.type, data: entry.data },
      { expanded: false },
      theme,
    );
    const lines = component.render(width);
    return { component, lines, plain: lines.map(stripTerminalSequences) };
  };
  const liveFooter = renderFooter();
  assert.equal(liveFooter.plain.length, 1);
  assert.ok(liveFooter.plain[0].startsWith("── ✓ Completed in 1m 5s "), liveFooter.plain[0]);
  assert.ok(liveFooter.plain[0].endsWith(" [Copy] ──"), liveFooter.plain[0]);
  const copyX = liveFooter.plain[0].indexOf("[Copy]") + 1;
  assert.ok(copyX > 0, liveFooter.plain[0]);
  assert.equal(liveFooter.component.handleMouse({
    type: "press", button: "left", x: copyX, y: 0, width: 80, height: 1,
  })?.handled, true);
  assert.equal(liveFooter.component.handleMouse({
    type: "click", button: "left", x: copyX, y: 0, width: 80, height: 1,
  })?.handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(nativeCopies, ["Published answer, first block.\n\nSecond block."]);
  // Footer Copy consumes press: test the captured-component click path too.
  for (const motions of [[[0, 0]], [[2, 0]], [[-2, 0]]]) {
    const before = nativeCopies.length;
    mouseGestureFixture(liveFooter.component, liveFooter.lines, 80).gesture(copyX, 0, motions);
    assert.equal(nativeCopies.length, before + 1, "footer Copy must tolerate jitter");
  }
  const beforeFooterDrag = nativeCopies.length;
  mouseGestureFixture(liveFooter.component, liveFooter.lines, 80).gesture(copyX, 0, [[3, 0], [0, 0]]);
  assert.equal(nativeCopies.length, beforeFooterDrag, "captured controls must not click after real drag");

  const restoredAnswer = {
    type: "message",
    id: "footer-answer",
    parentId: null,
    timestamp: "2026-01-01T00:01:10.000Z",
    message: {
      role: "assistant",
      timestamp: 70_000,
      stopReason: "stop",
      content: [{ type: "text", text: "Published answer, first block.\n\nSecond block." }],
    },
  };
  const restoredFooter = {
    type: "custom",
    id: "footer-entry",
    parentId: "footer-answer",
    timestamp: "2026-01-01T00:01:11.000Z",
    customType: "pretty-tui-response-footer",
    data: footerEntry.data,
  };
  const olderAnswer = {
    ...restoredAnswer,
    id: "older-answer",
    message: {
      ...restoredAnswer.message,
      // Timestamp collisions must not mix the answers for distinct footers.
      content: [{ type: "text", text: "Older answer, same timestamp" }],
    },
  };
  const olderFooter = {
    ...restoredFooter,
    id: "older-footer",
    parentId: "older-answer",
    data: { ...footerEntry.data, answerEntryId: "older-answer" },
  };
  await emit("session_start", {}, sessionContext([olderAnswer, olderFooter, restoredAnswer, restoredFooter]));
  const afterReload = renderFooter();
  assert.ok(afterReload.plain[0].includes("[Copy]"), afterReload.plain[0]);
  const clickFooter = (rendered) => {
    const x = rendered.plain[0].indexOf("[Copy]") + 1;
    assert.ok(x > 0);
    rendered.component.handleMouse({ type: "click", button: "left", x, y: 0, width: 80, height: 1 });
  };
  clickFooter(renderFooter(olderFooter));
  clickFooter(afterReload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(nativeCopies.slice(-2), [
    "Older answer, same timestamp",
    "Published answer, first block.\n\nSecond block.",
  ]);

  appendedEntries.length = 0;
  const stoppedBranch = [];
  const stoppedContext = sessionContext(stoppedBranch);
  stoppedContext.sessionManager.getBranch = () => stoppedBranch;
  await emit("session_start", {}, stoppedContext);
  await emit("agent_start");
  const interimMessage = {
    role: "assistant", timestamp: 71_000,
    content: [{ type: "text", text: "Searching, not a final answer" }],
  };
  await emit("message_end", { message: interimMessage });
  stoppedBranch.push({ type: "message", id: "interim", parentId: null, message: interimMessage });
  const terminalMessage = {
    role: "assistant",
    timestamp: 72_000,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    content: [],
  };
  await emit("message_end", { message: terminalMessage });
  stoppedBranch.push({ type: "message", id: "aborted", parentId: "interim", message: terminalMessage });
  await emit("agent_settled", {}, stoppedContext);
  const stoppedEntry = appendedEntries.find((entry) => entry.type === "pretty-tui-response-footer");
  assert.equal(stoppedEntry.data.outcome, "stopped");
  assert.equal(stoppedEntry.data.answerEntryId, undefined);
  const stopped = renderFooter(stoppedEntry);
  assert.ok(stopped.plain[0].includes("⚠ Stopped after"), stopped.plain[0]);
  assert.ok(!stopped.plain[0].includes("[Copy]"), stopped.plain[0]);

  const footerColors = [];
  const styledFooter = footerRenderer(
    { id: "footer-color", type: "custom", customType: footerEntry.type, data: footerEntry.data },
    { expanded: false },
    {
      bold: (text) => text,
      fg(name, text) {
        footerColors.push(name);
        return text;
      },
    },
  );
  styledFooter.render(80);
  assert.deepEqual([...new Set(footerColors)], ["dim"]);

  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "regular" } }, []);
  } catch {}
  assert.ok(!renderFooter().plain[0].includes("[Copy]"));
}

// User bubbles copy raw prompt text in fullscreen, without stealing code Copy
// controls, outside clicks, right clicks, wheel events, or selection drags.
{
  const copies = [];
  const flashes = [];
  const fullscreenUi = {
    mode: "fullscreen",
    async copyTextToClipboard(text) { copies.push(text); return true; },
    flash(message) { flashes.push(message); },
  };
  try { InteractiveMode.prototype.renderSessionEntries.call({ ui: fullscreenUi }, []); } catch {}
  const raw = "  用户 **hello**，这条消息保留原始 Markdown 与空白\n\n```sh\necho bubble\n```\n尾部  \n";
  const bubble = new UserMessageComponent(raw);
  const rows = () => bubble.render(100).map(stripTerminalSequences);
  const click = (x, y, extra = {}) => bubble.handleMouse({
    type: "click", button: "left", x, y, width: 100, height: rows().length, ...extra,
  });
  const left = rows()[0].indexOf("╭");
  const right = rows()[0].indexOf("╮");
  assert.ok(left > 0);
  assert.equal(click(left, 0)?.handled, true);
  assert.deepEqual(copies, [raw]);
  const bodyY = rows().findIndex((line) => line.includes("hello"));
  assert.equal(click(left + 2, bodyY)?.handled, true);
  assert.deepEqual(copies, [raw, raw]);
  assert.equal(click(right, rows().length - 1)?.handled, true);
  assert.equal(copies.at(-1), raw);
  const beforeIgnored = copies.length;
  for (const [x, y, extra] of [
    [left - 1, 0, {}], [right + 1, 0, {}], [left, -1, {}],
    [left, rows().length, {}], [left, 0, { button: "right" }],
    [left + 2, bodyY, { type: "drag" }], [left + 2, bodyY, { type: "scroll" }],
  ]) click(x, y, extra);
  assert.equal(copies.length, beforeIgnored);
  // A Markdown-owned click (such as a code Copy control) wins over the bubble.
  // The host can resolve its own pi-tui copy; inspect its native Markdown class.
  const probe = new UserMessageComponent("probe");
  originalPrototypeMethods.find(([label]) => label === "UserMessageComponent.rebuild")[3].call(probe);
  const nativeContent = probe.children[0];
  const nativeMarkdownPrototype = Object.getPrototypeOf(nativeContent.children?.[0] ?? nativeContent);
  const originalMarkdownMouse = nativeMarkdownPrototype.handleMouse;
  const hadOwnMarkdownMouse = Object.hasOwn(nativeMarkdownPrototype, "handleMouse");
  const beforeMarkdownClick = copies.length;
  let forwardedEvent;
  nativeMarkdownPrototype.handleMouse = (event) => { forwardedEvent = event; return { handled: true }; };
  try {
    assert.equal(click(left + 2, bodyY)?.handled, true);
    assert.equal(forwardedEvent.x, 0);
    assert.equal(forwardedEvent.y, bodyY - 1);
    assert.equal(copies.length, beforeMarkdownClick);
  } finally {
    if (hadOwnMarkdownMouse) nativeMarkdownPrototype.handleMouse = originalMarkdownMouse;
    else delete nativeMarkdownPrototype.handleMouse;
  }
  bubble.setOutputPad(3);
  assert.equal(click(rows()[0].indexOf("╭"), 0)?.handled, true);
  assert.equal(copies.at(-1), raw, "rebuild must preserve bubble copy");
  const userModeContext = { hasUI: true, ui: { notify() {} } };
  for (const mode of ["full", "compact"]) {
    await commands.get("pretty-tui").handler(mode, userModeContext);
    assert.ok(rows()[0].trimStart().startsWith("╭─ User "));
    assert.equal(rows()[0].indexOf("╮"), 98);
    assert.equal(click(1, 0)?.handled, true);
    assert.equal(copies.at(-1), raw, "User title and full-width border must not enter copied text");
  }
  await commands.get("pretty-tui").handler("clean", userModeContext);
  // Bubble press falls through to Pi's selection-based click pipeline.
  const jitterX = rows()[0].indexOf("╭") + 2;
  const jitterY = rows().findIndex((line) => line.includes("hello"));
  for (const motions of [[[0, 0]], [[1, 0]], [[-2, 0]], [[1, 0], [-1, 0]]]) {
    const before = copies.length;
    mouseGestureFixture(bubble, rows()).gesture(jitterX, jitterY, motions);
    assert.equal(copies.length, before + 1, `bubble jitter ${JSON.stringify(motions)}`);
    assert.equal(copies.at(-1), raw);
  }
  for (const motions of [[[3, 0]], [[0, 1]], [[3, 0], [0, 0]]]) {
    const before = copies.length;
    const fixture = mouseGestureFixture(bubble, rows());
    fixture.gesture(jitterX, jitterY, motions);
    assert.equal(copies.length, before, "real drag must not copy a bubble");
    assert.equal(fixture.screen.selectionDragged, true);
  }
  const beforeProtected = copies.length;
  const overlayFixture = mouseGestureFixture(bubble, rows());
  overlayFixture.screen.hasOverlay = () => true;
  overlayFixture.gesture(jitterX, jitterY, [[0, 0]]);
  const linkFixture = mouseGestureFixture(bubble, rows());
  linkFixture.screen.previousScreen = rows().map((line) => `\x1b]8;;https://example.com\x07${line}\x1b]8;;\x07`);
  linkFixture.gesture(jitterX, jitterY, [[0, 0]]);
  assert.equal(copies.length, beforeProtected, "overlay/link selection must not gain jitter tolerance");
  // Do not change Pi's double/triple-click word-selection behavior in this fix.
  const nativeFixture = mouseGestureFixture(bubble, rows(), 100, true);
  const wordX = visibleWidth(rows()[jitterY].slice(0, rows()[jitterY].indexOf("hello"))) + 2;
  const perClick = [];
  for (let i = 0; i < 4; i++) {
    const before = copies.length;
    nativeFixture.gesture(wordX, jitterY);
    perClick.push(copies.length - before);
  }
  assert.deepEqual(perClick, [1, 0, 0, 1]);
  // Ordinary transcript text retains exact native drag detection.
  let ordinaryClicks = 0;
  const ordinary = { handleMouse(event) { if (event.type === "click") { ordinaryClicks++; return { handled: true }; } } };
  const ordinaryFixture = mouseGestureFixture(ordinary, ["ordinary transcript text"]);
  ordinaryFixture.gesture(5, 0, [[0, 0]]);
  assert.equal(ordinaryClicks, 0);
  assert.equal(ordinaryFixture.screen.selectionDragged, true);
  fullscreenUi.copyTextToClipboard = async () => { throw new Error("clipboard unavailable"); };
  click(rows()[0].indexOf("╭"), 0);
  await Promise.resolve();
  assert.deepEqual(flashes, ["Copy failed"]);
  try { InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "regular" } }, []); } catch {}
  const beforeRegular = copies.length;
  assert.equal(click(rows()[0].indexOf("╭"), 0), undefined);
  assert.equal(copies.length, beforeRegular);
}

// Fullscreen Markdown shows per-block Copy controls with precise hit regions;
// regular mode hides them and invalidation drops stale regions.
{
  const nativeCopies = [];
  const fullscreenUi = {
    mode: "fullscreen",
    async copyTextToClipboard(text) {
      nativeCopies.push(text);
      return true;
    },
  };
  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: fullscreenUi }, []);
  } catch {}
  const markdownTheme = new Proxy({
    heading: (text) => `\x1b[38;2;240;198;116m${text}\x1b[39m`,
    quote: (text) => `\x1b[90m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
    underline: (text) => `\x1b[4m${text}\x1b[24m`,
    codeBlock: (text) => text,
    codeBlockBorder: (text) => `\x1b[90m${text}\x1b[39m`,
    highlightCode: (code) => code.split("\n"),
  }, { get: (target, key) => target[key] ?? ((text) => text) });
  let transcriptMarkdownTimestamp = 60_000;
  const transcriptMarkdownFixture = (
    source,
    theme = markdownTheme,
    paddingX = 0,
    paddingY = 0,
    defaultTextStyle = undefined,
  ) => {
    const message = {
      role: "assistant",
      timestamp: transcriptMarkdownTimestamp++,
      stopReason: "stop",
      content: [{ type: "text", text: "placeholder" }],
    };
    const component = new AssistantMessageComponent(message);
    const markdown = new Markdown(source, paddingX, paddingY, theme, defaultTextStyle);
    component.contentContainer.clear();
    component.contentContainer.addChild(markdown);
    return {
      component,
      markdown,
      render: (width) => component.render(width),
      handleMouse: (event) => component.handleMouse(event),
    };
  };
  const stripControls = (line) => line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  const headingCases = [
    ["# One", ["╔═════╗", "║ One ║", "╚═════╝"]],
    ["## Two", ["Two"]],
    ["### Three", ["Three"]],
    ["#### Four", ["Four"]],
    ["##### Five", ["┄┄ Five ┄┄"]],
    ["###### Six", ["Six"]],
  ];
  for (const [source, expected] of headingCases) {
    const rendered = transcriptMarkdownFixture(source).render(20);
    const unstyled = rendered.map((line) => stripControls(line).trimEnd());
    assert.deepEqual(unstyled, expected);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 20));
  }
  const primaryHeading = transcriptMarkdownFixture("# Primary").render(20);
  const secondaryHeading = transcriptMarkdownFixture("## Secondary").render(20);
  assert.ok(primaryHeading.every((line) => !line.includes("\x1b[7m")));
  assert.ok(primaryHeading[1].includes("\x1b[4m"));
  assert.ok(secondaryHeading[0].includes("\x1b[48;5;94m"));
  assert.ok(secondaryHeading[0].includes("\x1b[97m") && secondaryHeading[0].includes("\x1b[4m"));
  assert.ok(!secondaryHeading[0].includes("\x1b[7m"));
  const lightMarkdownTheme = {
    ...markdownTheme,
    heading: (text) => `\x1b[38;2;154;115;38m${text}\x1b[39m`,
  };
  const lightSecondaryHeading = transcriptMarkdownFixture(
    "## Light",
    lightMarkdownTheme,
    0,
    0,
    { color: (text) => `\x1b[38;2;31;35;40m${text}\x1b[39m` },
  ).render(20);
  assert.ok(lightSecondaryHeading[0].includes("\x1b[107m"));
  assert.ok(lightSecondaryHeading[0].includes("\x1b[7m"));
  assert.ok(!lightSecondaryHeading[0].includes("\x1b[48;5;94m"));
  const sixthHeading = transcriptMarkdownFixture("###### Readable").render(20);
  assert.ok(sixthHeading[0].includes("\x1b[3m") && sixthHeading[0].includes("\x1b[90m"));
  const narrowHeading = transcriptMarkdownFixture("# Narrow heading").render(5);
  assert.ok(narrowHeading.every((line) => visibleWidth(line) <= 5));

  const borderColors = [];
  const codeBorderContext = sessionContext([]);
  codeBorderContext.ui.theme = {
    ...theme,
    fg(color, text) {
      borderColors.push([text, color]);
      return color === "borderMuted" ? `\x1b[38;5;240m${text}\x1b[39m` : text;
    },
  };
  await emit("session_start", {}, codeBorderContext);
  const markdownFixture = transcriptMarkdownFixture(
    "```ts\nconst a = 1;\n```\n\n~~~json\n{\"ok\":true}\n~~~",
    markdownTheme,
    2,
    1,
  );
  const { markdown } = markdownFixture;
  const lines = markdownFixture.render(42);
  assert.ok(borderColors.some(([text, color]) => text === "╭─ " && color === "borderMuted"));
  assert.ok(borderColors.some(([text, color]) => text === "│ " && color === "borderMuted"));
  assert.ok(borderColors.some(([text, color]) => text.startsWith("╰─") && color === "borderMuted"));
  assert.ok(!borderColors.some(([text]) => text.includes("[Copy]") || text.includes("const a")));
  assert.ok(lines.some((line) => line.includes("\x1b[90mts ")));
  assert.ok(lines.some((line) => line.includes("\x1b[90m [Copy] ")));
  const plain = lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  const headers = plain.map((line, y) => ({ line, y })).filter(({ line }) => line.includes("[Copy]"));
  assert.equal(headers.length, 2);
  assert.ok(headers.every(({ line }) => line.trimStart().startsWith("╭─")));
  assert.ok(plain.some((line) => line.includes("│ const a = 1;")));
  assert.ok(plain.some((line) => line.trimStart().startsWith("╰─")));
  for (const { line, y } of headers) {
    const x = line.indexOf("[Copy]") + 1;
    // Fullscreen layout hit-testing can dispatch directly to the Markdown leaf,
    // bypassing AssistantMessageComponent.handleMouse entirely.
    assert.equal(markdown.handleMouse({ type: "press", button: "left", x, y, width: 42, height: lines.length })?.handled, true);
  }
  const firstCopyX = headers[0].line.indexOf("[Copy]") + 1;
  assert.equal(markdownFixture.handleMouse({
    type: "click",
    button: "left",
    x: firstCopyX,
    y: headers[0].y,
    width: 42,
    height: lines.length,
  })?.handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(nativeCopies, ["const a = 1;"]);

  const indentedFixture = transcriptMarkdownFixture("```txt\n  keep indentation\n```");
  const indentedLines = indentedFixture.render(42).map(stripControls);
  const indentedY = indentedLines.findIndex((line) => line.includes("[Copy]"));
  assert.ok(indentedY >= 0);
  indentedFixture.handleMouse({
    type: "click", button: "left", x: indentedLines[indentedY].indexOf("[Copy]") + 1,
    y: indentedY, width: 42, height: indentedLines.length,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeCopies.at(-1), "  keep indentation");

  const copyFirst = {
    type: "message",
    id: "30",
    parentId: null,
    timestamp: "2026-01-01T00:00:30.000Z",
    message: {
      role: "assistant",
      timestamp: 30_000,
      content: [
        { type: "thinking", thinking: "Prepare copied answer" },
        { type: "toolCall", id: "copy-tool", name: "obs_recall", arguments: {} },
      ],
    },
  };
  const copyMixed = {
    type: "message",
    id: "32",
    parentId: "31",
    timestamp: "2026-01-01T00:00:32.000Z",
    message: {
      role: "assistant",
      timestamp: 32_000,
      content: [
        { type: "thinking", thinking: "Finish copied answer" },
        { type: "text", text: "Answer:\n\n```sh\necho mixed response\n```" },
      ],
    },
  };
  await emit("session_start", {}, sessionContext([
    copyFirst,
    result("31", "30", "copy-tool"),
    copyMixed,
  ]));
  const copyFirstComponent = new AssistantMessageComponent(copyFirst.message);
  const copyMixedComponent = new AssistantMessageComponent(copyMixed.message);
  copyFirstComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 42, height: copyFirstComponent.render(42).length,
  });
  // Keep the regression focused on AssistantMessage mouse-coordinate routing;
  // Pi's assistant Markdown transformer is tested independently upstream.
  copyMixedComponent.contentContainer.clear();
  copyMixedComponent.contentContainer.addChild(new Markdown(
    "```sh\necho mixed response\n```",
    1,
    0,
    markdownTheme,
  ));
  const mixedCopyLines = copyMixedComponent.render(42);
  const mixedCopyPlain = mixedCopyLines.map((line) =>
    line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
  );
  const mixedCopyY = mixedCopyPlain.findIndex((line) => line.includes("[Copy]"));
  assert.ok(mixedCopyY >= 0);
  const mixedCopyX = mixedCopyPlain[mixedCopyY].indexOf("[Copy]") + 1;
  assert.equal(copyMixedComponent.handleMouse({
    type: "press", button: "left", x: mixedCopyX, y: mixedCopyY, width: 42, height: mixedCopyLines.length,
  })?.handled, true);
  assert.equal(copyMixedComponent.handleMouse({
    type: "click", button: "left", x: mixedCopyX, y: mixedCopyY, width: 42, height: mixedCopyLines.length,
  })?.handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(nativeCopies, ["const a = 1;", "  keep indentation", "echo mixed response"]);
  const jitterCode = transcriptMarkdownFixture("```sh\necho jitter\n```");
  const jitterCodeLines = jitterCode.render(42);
  const jitterPlain = jitterCodeLines.map(stripTerminalSequences);
  const jitterY = jitterPlain.findIndex((line) => line.includes("[Copy]"));
  const jitterX = jitterPlain[jitterY].indexOf("[Copy]") + 1;
  for (const motions of [[[0, 0]], [[-2, 0]], [[2, 0]]]) {
    const before = nativeCopies.length;
    mouseGestureFixture(jitterCode.markdown, jitterCodeLines, 42).gesture(jitterX, jitterY, motions);
    assert.equal(nativeCopies.length, before + 1, "code Copy must tolerate jitter");
    assert.equal(nativeCopies.at(-1), "echo jitter");
  }
  const beforeCodeDrag = nativeCopies.length;
  mouseGestureFixture(jitterCode.markdown, jitterCodeLines, 42).gesture(jitterX, jitterY, [[3, 0]]);
  assert.equal(nativeCopies.length, beforeCodeDrag);

  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
  for (const width of [1, 4, 7, 8, 17, 18, 24]) {
    const narrow = transcriptMarkdownFixture(
      "```sh\necho 12345678901234567890\n```",
    ).render(width);
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    const hasCopy = narrow.some((line) =>
      line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("[Copy]"),
    );
    assert.equal(hasCopy, width >= 18);
  }
  markdown.setText("updated");
  markdownFixture.render(42);
  const staleX = headers[0].line.indexOf("[Copy]") + 1;
  assert.equal(markdownFixture.handleMouse({ type: "press", button: "left", x: staleX, y: headers[0].y, width: 42, height: lines.length })?.handled, undefined);

  // Markdown rendered outside the main transcript stays native even in
  // fullscreen mode, matching plugin overlays such as ask_user_question.
  const overlayMarkdown = new Markdown("# Overlay\n\n```ts\nconst native = true;\n```", 0, 0, markdownTheme);
  const overlayLines = overlayMarkdown.render(30).map((line) => stripControls(line).trimEnd());
  assert.deepEqual(overlayLines.slice(0, 2), ["Overlay", ""]);
  assert.ok(overlayLines.some((line) => line.startsWith("```ts")));
  assert.ok(overlayLines.every((line) => !line.includes("[Copy]") && !line.includes("╭─")));

  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "regular" } }, []);
  } catch {}
  const regular = transcriptMarkdownFixture("```sh\necho regular\n```").render(30);
  assert.ok(regular.every((line) => !line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("[Copy]")));
  try { InteractiveMode.prototype.renderSessionEntries.call({ ui: fullscreenUi }, []); } catch {}
  const fullCommandContext = { hasUI: true, ui: { notify() {} } };
  await commands.get("pretty-tui").handler("full", fullCommandContext);
  const replyCard = transcriptMarkdownFixture("```sh\necho framed answer\n```");
  const replyCardRows = replyCard.render(48).map(stripControls);
  assert.ok(replyCardRows[0].includes("╭─ Assistant"));
  const cardCopyY = replyCardRows.findIndex((line) => line.includes("[Copy]"));
  assert.ok(cardCopyY > 0);
  const cardCopyX = replyCardRows[cardCopyY].indexOf("[Copy]") + 1;
  const cardClick = { button: "left", x: cardCopyX, y: cardCopyY, width: 48, height: replyCardRows.length };
  assert.equal(replyCard.handleMouse({ ...cardClick, type: "press" })?.handled, true);
  assert.equal(replyCard.handleMouse({ ...cardClick, type: "click" })?.handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeCopies.at(-1), "echo framed answer", "Assistant borders and title must not enter copied code");
  await commands.get("pretty-tui").handler("clean", fullCommandContext);
  try { InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "regular" } }, []); } catch {}
}

// Clean summary rows tolerate a two-cell horizontal wobble while ordinary
// fullscreen text selection keeps Pi's exact drag behavior.
{
  const clicks = [];
  const screen = {
    previousScreen: ["● Done(2 tool calls)"],
    terminal: { rows: 1, columns: 80 },
    currentLayout: undefined,
    copyOnSelect: false,
    hasOverlay: () => false,
    stopSelectionAutoScroll() {},
    getSelectionPoint: (event) => ({ row: event.y, col: event.x, scrollView: undefined }),
    getWordSelection: () => undefined,
    getClickCount: () => 1,
    createMouseEvent: (_type, _button, x, y) => ({ type: "click", button: "left", x, y }),
    dispatchMouseToOverlay: () => ({ hit: false, result: undefined }),
    dispatchMouseToLayout: (event) => {
      clicks.push(event);
      return { handled: true };
    },
    applyMouseDispatchResult: () => false,
    clearTextSelection() {},
    requestRender() {},
    updateSelectionFocus(point) { this.selectionFocus = point; },
    updateSelectionAutoScroll() {},
  };
  const handleSelection = TuiAltScreen.prototype.handleSelectionMouseEvent;
  handleSelection.call(screen, { button: 0, release: false, x: 5, y: 0 });
  handleSelection.call(screen, { button: 32, release: false, x: 7, y: 0 });
  handleSelection.call(screen, { button: 3, release: true, x: 7, y: 0 });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].x, 5);
}

const patchedSelectionHandler = TuiAltScreen.prototype.handleSelectionMouseEvent;
const patchedMarkdownRenderToken = Markdown.prototype.renderToken;
const patchedAssistantRender = AssistantMessageComponent.prototype.render;
const patchedAssistantMouse = AssistantMessageComponent.prototype.handleMouse;
const patchedCustomMessageRender = CustomMessageComponent.prototype.render;
const patchedToolRender = ToolExecutionComponent.prototype.render;
const patchedShowExtensionNotify = InteractiveMode.prototype.showExtensionNotify;
// Every patch key must be present while the extension is active, so the
// post-shutdown check below cannot pass by testing keys that were never set.
for (const key of [...protoPatchKeys, ...symbolPatchKeys]) {
  assert.notEqual(key.owner[key.symbol], undefined, `${key.label} patch key was never installed`);
}

// session_shutdown must also drop the transient UI flash and its timer.
// Codemode/nested tools: one real transcript component owns independently
// expandable children. Internal events must not create phantom top-level rows.
{
  await emit("session_start", {}, sessionContext([]));
  await emit("agent_start");
  const realNestedNow = Date.now;
  let nestedNow = realNestedNow();
  Date.now = () => nestedNow;
  const parentId = "nested-parent";
  const root = new ToolExecutionComponent("codemode", parentId,
    { code: 'const r = await tools.read({path:"demo.txt"}); text(r);' }, undefined,
    { renderCall: () => new Text("native script", 0, 0) }, { requestRender() {} }, process.cwd());
  root.markExecutionStarted();
  await emit("tool_execution_start", { toolCallId: parentId, toolName: "codemode", args: root.args });
  const start = (id, name, args, parentToolCallId = parentId) => emit("tool_execution_start", {
    toolCallId: id, toolName: name, args, parentToolCallId,
  });
  const end = (id, name, text, isError = false, parentToolCallId = parentId) => emit("tool_execution_end", {
    toolCallId: id, toolName: name, parentToolCallId, isError,
    result: { content: [{ type: "text", text }] },
  });
  await start(`${parentId}/1`, "read", { path: "demo.txt", apiKey: "HIDDEN_SECRET" });
  await start(`${parentId}/2`, "remote", {});
  await start(`${parentId}/2/1`, "grep", { pattern: "fixture" }, `${parentId}/2`);
  root.setExpanded(true); // reveal the group without expanding all details
  const render = (width = 120) => root.render(width).map(stripTerminalSequences);
  assert.match(render().join("\n"), /Running\(4 tool calls/);
  assert.ok(!render()[1].includes("nested calls"), "summary must merge top-level and nested counts");
  assert.match(render().join("\n"), /Running…/);
  assert.ok(!render().join("\n").includes("HIDDEN_SECRET"));
  await emit("tool_execution_update", {
    toolCallId: `${parentId}/1`, toolName: "read", parentToolCallId: parentId,
    partialResult: { content: [{ type: "text", text: "Reading fixture…" }] },
  });
  assert.match(render().join("\n"), /Reading fixture/);
  await end(`${parentId}/1`, "read", "Read 2 lines\nPRIVATE CHILD DETAIL");
  await end(`${parentId}/2/1`, "grep", "No permission", true, `${parentId}/2`);
  await end(`${parentId}/2`, "remote", "Handled child error");
  const rootResult = { content: [{ type: "text", text: "Script completed\nFINAL SCRIPT OUTPUT" }], isError: false };
  await emit("tool_execution_end", { toolCallId: parentId, toolName: "codemode", result: rootResult, isError: false });
  root.updateResult(rootResult);
  nestedNow += 2000; // expire the existing minimum tool-status hold
  await emit("agent_settled");
  let lines = render();
  assert.match(lines.join("\n"), /Done\(4 tool calls/);
  assert.match(lines.join("\n"), /3 nested calls · 1 failed/);
  assert.ok(!lines.join("\n").includes("PRIVATE CHILD DETAIL"));
  assert.ok(!lines.join("\n").includes("FINAL SCRIPT OUTPUT"));
  assert.equal(lines.at(-1), "  └─ [↑ Collapse]", "nested events displaced the group's collapse action");
  const clickRow = (needle) => {
    const rows = render();
    const y = rows.findIndex((line) => line.includes(needle));
    assert.ok(y >= 0, rows.join("\n"));
    assert.equal(root.handleMouse({ type: "click", button: "left", x: 14, y, width: 120, height: rows.length })?.handled, true);
  };
  const beforeParentClick = render();
  clickRow("codemode(");
  assert.deepEqual(render(), beforeParentClick, "parent title click must not expand details");
  assert.equal(root.expanded, false);
  const readRow = render().findIndex((line) => line.includes("read("));
  mouseGestureFixture(root, render(), 120).gesture(14, readRow, [[2, 0]]);
  assert.match(render().join("\n"), /PRIVATE CHILD DETAIL/, "nested tool click must tolerate jitter");
  clickRow("PRIVATE CHILD DETAIL");
  clickRow("read(");
  assert.match(render().join("\n"), /PRIVATE CHILD DETAIL/);
  assert.ok(!render().join("\n").includes("FINAL SCRIPT OUTPUT"));
  clickRow("[Script output]");
  assert.match(render().join("\n"), /FINAL SCRIPT OUTPUT/);
  clickRow("[Script]");
  assert.match(render().join("\n"), /const r = await tools/);
  clickRow("const r = await tools");
  assert.ok(!render().join("\n").includes("const r = await tools"), "script body click must collapse script");
  assert.match(render().join("\n"), /PRIVATE CHILD DETAIL/);
  clickRow("FINAL SCRIPT OUTPUT");
  assert.ok(!render().join("\n").includes("FINAL SCRIPT OUTPUT"), "output body click must collapse output");
  clickRow("PRIVATE CHILD DETAIL");
  assert.ok(!render().join("\n").includes("PRIVATE CHILD DETAIL"), "child body click must collapse child only");
  clickRow("[Script]");
  clickRow("[Script]");
  assert.ok(!render().join("\n").includes("const r = await tools"), "header click must still toggle script");
  const expansionHost = {
    ui: { requestRender() {} },
    chatContainer: { children: [root] },
    loadedResourcesContainer: { children: [] },
    toolOutputExpanded: false,
    showStatus() {},
  };
  InteractiveMode.prototype.setToolsExpanded.call(expansionHost, true);
  assert.equal(root.expanded, true);
  assert.match(render().join("\n"), /PRIVATE CHILD DETAIL/);
  assert.match(render().join("\n"), /FINAL SCRIPT OUTPUT/);
  assert.match(render().join("\n"), /const r = await tools/);
  const globallyExpandedRows = render();
  clickRow("codemode(");
  assert.deepEqual(render(), globallyExpandedRows, "parent title click must not collapse details");
  clickRow("PRIVATE CHILD DETAIL");
  assert.ok(!render().join("\n").includes("PRIVATE CHILD DETAIL"));
  assert.match(render().join("\n"), /FINAL SCRIPT OUTPUT/);
  clickRow("FINAL SCRIPT OUTPUT");
  assert.ok(!render().join("\n").includes("FINAL SCRIPT OUTPUT"));
  assert.match(render().join("\n"), /const r = await tools/);
  clickRow("const r = await tools");
  assert.ok(!render().join("\n").includes("const r = await tools"));
  clickRow("read(");
  assert.match(render().join("\n"), /PRIVATE CHILD DETAIL/);
  InteractiveMode.prototype.setToolsExpanded.call(expansionHost, false);
  assert.ok(!render().join("\n").includes("PRIVATE CHILD DETAIL"));
  InteractiveMode.prototype.setToolsExpanded.call(expansionHost, true);
  assert.match(render().join("\n"), /FINAL SCRIPT OUTPUT/, "fresh global expansion clears local overrides");
  InteractiveMode.prototype.setToolsExpanded.call(expansionHost, false);
  root.setExpanded(true); // reveal the group again, not the details
  for (const width of [1, 12, 40, 80]) assert.ok(render(width).every((line) => visibleWidth(line) <= width));
  const collapseRows = render();
  const collapseY = collapseRows.length - 1;
  mouseGestureFixture(root, collapseRows, 120).gesture(10, collapseY, [[-2, 0]]);
  assert.ok(!render().join("\n").includes("read("));
  assert.ok(!render().join("\n").includes("[↑ Collapse]"));

  const saved = appendedEntries.findLast((entry) => entry.type === "pretty-tui-nested-results" && entry.data.rootId === parentId);
  assert.ok(saved);
  assert.equal(saved.data.calls.length, 3);
  assert.ok(!JSON.stringify(saved).includes("HIDDEN_SECRET"));
  // Restore a branch that has the hidden UI snapshot plus native call metadata.
  const history = [assistant("80", undefined, [{ id: parentId, name: "codemode" }]),
    { type: "custom", customType: saved.type, data: saved.data },
    { ...result("81", "80", parentId), message: { role: "toolResult", toolCallId: parentId,
      nestedCalls: { calls: [{ id: `${parentId}/1`, name: "read", status: "ok", arguments: { path: "demo.txt" } }], complete: true },
      content: rootResult.content } }];
  await emit("session_start", {}, sessionContext(history));
  const restored = new ToolExecutionComponent("codemode", parentId, { code: "text('restored')" }, undefined,
    undefined, { requestRender() {} }, process.cwd());
  restored.updateResult(rootResult);
  restored.render(120); restored.setExpanded(true);
  let rows = restored.render(120).map(stripTerminalSequences);
  assert.match(rows.join("\n"), /Done\(4 tool calls/);
  const y = rows.findIndex((line) => line.includes("read("));
  restored.handleMouse({ type: "click", button: "left", x: 14, y, width: 120, height: rows.length });
  assert.match(restored.render(120).map(stripTerminalSequences).join("\n"), /PRIVATE CHILD DETAIL/);
  Date.now = realNestedNow;
}

// Metadata-only older sessions still expose child arguments/status, without
// claiming their original results were saved. UI snapshots have strict limits.
{
  const { NestedTools, NESTED_LIMITS } = await import("../extensions/nested-tools.ts");
  const nested = new NestedTools();
  nested.absorb("old", { calls: [
    { id: "old/1", name: "read", arguments: { path: "history.txt" }, status: "ok", durationMs: 12 },
    { id: "old/2", name: "remote", status: "unfinished", argumentsBytes: 9000 },
  ], complete: false });
  const owner = { toolCallId: "old", toolName: "codemode", args: { code: "text('history')" }, result: { content: [] }, expanded: false };
  const disclosureColors = [];
  const disclosureTheme = { ...theme, fg(color, text) { disclosureColors.push([text, color]); return text; } };
  const oldLines = nested.render(owner, 100, disclosureTheme).lines.join("\n");
  assert.ok(disclosureColors.some(([text, color]) => stripTerminalSequences(text) === "codemode" && color === "text"));
  assert.ok(disclosureColors.some(([text, color]) => stripTerminalSequences(text) === "read" && color === "text"));
  assert.ok(disclosureColors.some(([text, color]) => text === "[Script]" && color === "mdLink"));
  assert.ok(disclosureColors.some(([text, color]) => text === "[Script output]" && color === "mdLink"));
  assert.ok(disclosureColors.some(([text, color]) => text === "  ├─ " && color === "dim"));
  assert.match(oldLines, /Only call metadata retained/);
  assert.match(oldLines, /history.txt/);
  assert.match(oldLines, /incomplete/);
  assert.equal(nested.children("old")[1].status, "cancelled");
  nested.absorb("old", [{ id: "old/3", name: "read", status: "error" }]);
  disclosureColors.length = 0;
  const statusLines = nested.render(owner, 100, disclosureTheme).lines.join("\n");
  assert.ok(disclosureColors.some(([text, color]) => text === "● " && color === "success"));
  assert.ok(disclosureColors.some(([text, color]) => text === "● " && color === "error"));
  assert.ok(!statusLines.includes("✕"), "failed nested tools must use the same dot as top-level tools");

  nested.absorb("secrets", [{ id: "secrets/1", name: "read", args: '{"apiKey":"META_SECRET"}', status: "ok" }]);
  nested.absorb("secrets", [{ id: "secrets/2", name: "read", args: '{"token":"TRUNCATED_SECRET', status: "ok" }]);
  assert.ok(!JSON.stringify(nested.snapshot("secrets")).includes("META_SECRET"));
  assert.ok(!JSON.stringify(nested.snapshot("secrets")).includes("TRUNCATED_SECRET"));
  nested.clear();
  for (let i = 0; i <= NESTED_LIMITS.calls; i++) {
    nested.start({ toolCallId: `big/${i}`, parentToolCallId: "big", toolName: "read", args: { value: "x".repeat(6000) } });
    nested.update({ toolCallId: `big/${i}`, result: { content: [{ type: "text", text: "y".repeat(12000) }] } }, true);
  }
  const snapshot = nested.snapshot("big");
  assert.equal(snapshot.calls.length, NESTED_LIMITS.calls);
  assert.equal(snapshot.incomplete, true);
  assert.ok(snapshot.calls.reduce((sum, call) => sum + call.args.length + (call.output?.length ?? 0), 0) <= NESTED_LIMITS.total);
  assert.ok(snapshot.calls.every((call) => (call.output?.length ?? 0) <= NESTED_LIMITS.output));
  const restored = new NestedTools(); restored.restore(snapshot);
  assert.equal(restored.count("big"), NESTED_LIMITS.calls);
  nested.clear();
  nested.start({ toolCallId: "cancel/1", parentToolCallId: "cancel", toolName: "bash", args: {} });
  disclosureColors.length = 0;
  const runningLines = nested.render({ toolCallId: "cancel", toolName: "codemode", args: {} }, 100, disclosureTheme).lines.join("\n");
  const runningDots = disclosureColors.filter(([text]) => text === "● ");
  assert.equal(runningDots.length, 2, "check both parent and child running dots");
  assert.ok(runningDots.every(([, color]) => color === "dim"));
  assert.match(runningLines, /● bash/);
  assert.ok(!runningLines.includes("… bash"), "running nested tools must use a dot, not an ellipsis");
  assert.deepEqual(nested.finishAll(), ["cancel"]);
  assert.equal(nested.children("cancel")[0].status, "cancelled");
  nested.absorb("wrapper", [{ id: "wrapper/1", name: "mcp.tool", args: "{}", status: "ok" }]);
  assert.match(nested.render({ toolCallId: "wrapper", toolName: "other-wrapper", args: {}, result: {} }, 80, theme).lines.join("\n"), /mcp.tool/);
}

// Repaints reuse wrapped nested details, but every visible change invalidates
// the owning tree. Unrelated live tools must not evict completed history.
{
  const { NestedTools } = await import("../extensions/nested-tools.ts");
  const nested = new NestedTools();
  const start = (root) => nested.start({ toolCallId: `${root}/1`, parentToolCallId: root, toolName: "read", args: { path: "cached.ts" } });
  const update = (root, text) => nested.update({ toolCallId: `${root}/1`, result: { content: [{ type: "text", text }] } }, true);
  start("cached"); update("cached", "First line\nCACHED_DETAIL");
  const owner = { toolCallId: "cached", toolName: "codemode", expanded: true, args: {}, result: { content: [] } };
  let color = "dark";
  const cacheTheme = { bold: (s) => s, fg: (role, s) => `<${color}:${role}>${s}` };
  const render = (width = 100, rootDetails = false) => nested.render(owner, width, cacheTheme, { rootDetails });
  const first = render();
  assert.equal(render(), first, "unchanged repaint reuses rows and hit regions");
  start("other"); update("other", "UNRELATED_UPDATE");
  assert.equal(render(), first, "another active root must not evict this cached history");
  nested.toggle("cached/1", true);
  assert.ok(!render().lines.join("\n").includes("CACHED_DETAIL"));
  nested.clearExpansion();
  assert.ok(render().lines.join("\n").includes("CACHED_DETAIL"));
  update("cached", "Changed line\nUPDATED_DETAIL");
  assert.ok(render().lines.join("\n").includes("UPDATED_DETAIL"));
  assert.ok(!render().lines.join("\n").includes("CACHED_DETAIL"));
  const beforeTheme = render(); color = "light";
  assert.notEqual(render(), beforeTheme, "in-place theme changes must refresh cached colors");
  assert.ok(render().lines.some((line) => line.includes("<light:")));
  assert.notEqual(render(40), render(100));
  assert.notEqual(render(100, true), render(100, false));
  owner.expanded = false;
  assert.ok(!render().lines.join("\n").includes("UPDATED_DETAIL"));
  const { ThoughtPresentation } = await import("../extensions/thought-presentation.ts");
  const thought = new ThoughtPresentation();
  const thoughtOwner = { markdownTheme: getMarkdownTheme() };
  const details = thought.details(thoughtOwner, "LONG_THOUGHT_DETAIL", cacheTheme, 80);
  assert.equal(thought.details(thoughtOwner, "LONG_THOUGHT_DETAIL", cacheTheme, 80), details);
  color = "changed";
  assert.notEqual(thought.details(thoughtOwner, "LONG_THOUGHT_DETAIL", cacheTheme, 80), details);
  assert.ok(thought.details(thoughtOwner, "NEW_THOUGHT_DETAIL", cacheTheme, 80).join("\n").includes("NEW_THOUGHT_DETAIL"));
}

// Card surfaces retain outline hues, stay readable, and follow theme changes
// without recomputing color conversion on every row or repaint.
{
  const { cardSurface } = await jiti.import(join(process.cwd(), "extensions/card-surface.ts"));
  const { frameNativeRows } = await jiti.import(join(process.cwd(), "extensions/full-frame.ts"));
  const { oklchColor, colorToRgb, colorToOklch, backgroundAnsi } = await import("@earendil-works/pi-tui");
  const styles = [];
  let mode = "truecolor";
  const surfaceTheme = {
    appearance: "dark",
    colors: {
      mdLink: oklchColor(0.72, 0.15, 250), mdHeading: oklchColor(0.8, 0.12, 80), accent: oklchColor(0.75, 0.17, 295),
      success: oklchColor(0.78, 0.16, 145), error: oklchColor(0.68, 0.18, 25),
      text: oklchColor(0.95, 0, 0),
    },
    getColorMode: () => mode, fg: (_role, text) => text, bold: (text) => text,
    style(text, { bg }) { styles.push(bg); return backgroundAnsi(bg, mode) + text + "\x1b[49m"; },
  };
  const luminance = (color) => {
    const rgb = colorToRgb(color);
    const linear = (value) => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const swatches = new Set();
  for (const role of ["mdLink", "mdHeading", "accent", "success", "error", "text"]) {
    const surface = cardSurface(surfaceTheme, role);
    const fill = styles.at(-1);
    const outline = colorToOklch(surfaceTheme.colors[role]);
    assert.ok(fill.l < outline.l && fill.c <= outline.c, role);
    assert.ok(Math.abs(fill.h - outline.h) < 0.001, `${role}: keep outline hue`);
    assert.ok(contrast(fill, surfaceTheme.colors.text) >= 4.5, `${role}: dark-theme text contrast`);
    swatches.add(surface.prefix);
    const calls = styles.length;
    assert.equal(cardSurface(surfaceTheme, role), surface);
    assert.equal(styles.length, calls, "unchanged surfaces reuse color conversion");
  }
  assert.equal(swatches.size, 6);
  const owner = {};
  const first = frameNativeRows("thought", ["text"], 80, surfaceTheme, undefined, owner, "mdLink", "", "mdLink");
  surfaceTheme.colors.mdLink = oklchColor(0.7, 0.16, 205);
  const changed = frameNativeRows("thought", ["text"], 80, surfaceTheme, undefined, owner, "mdLink", "", "mdLink");
  assert.notEqual(changed, first, "in-place theme color updates invalidate panel caches");
  assert.notEqual(changed.lines[0], first.lines[0]);
  surfaceTheme.appearance = "light";
  for (const role of ["mdLink", "mdHeading", "accent", "success", "error", "text"]) {
    cardSurface(surfaceTheme, role);
    assert.ok(contrast(styles.at(-1), oklchColor(0.18, 0, 0)) >= 4.5, `${role}: light-theme text contrast`);
  }
  mode = "256color";
  assert.ok(cardSurface(surfaceTheme, "mdLink").prefix.includes("\x1b[48;5;"));
}

// Full panels share a themed surface and retain native content/coordinates.
// Tool call and output occupy one frame, not separate nested cards.
{
  const { renderToolProjection } = await jiti.import(join(process.cwd(), "extensions/tool-presentation.ts"));
  const { NestedTools } = await import("../extensions/nested-tools.ts");
  const { frameNativeRows, frameNativeToolRows, cardBackground } = await jiti.import(join(process.cwd(), "extensions/full-frame.ts"));
  const { stripAnsiBackgrounds } = await jiti.import(join(process.cwd(), "extensions/ansi-style.ts"));
  const nested = new NestedTools();
  nested.start({ toolCallId: "media/1", parentToolCallId: "media", toolName: "read", args: {} });
  const image = "\x1b_Ga=T,f=100;IMAGE_PROTOCOL_PAYLOAD\x1b\\";
  const nativeLines = ["", "\x1b[44mNATIVE MEDIA TITLE\x1b[49m", image];
  const projection = renderToolProjection({ toolCallId: "media", toolName: "codemode", args: { code: "ROOT_SCRIPT" } }, 40, theme, {
    mode: "full", nested, nestedExpanded: true, renderNative: () => nativeLines,
  });
  assert.ok(projection.lines.includes(image));
  assert.equal(projection.native.height, nativeLines.length);
  assert.equal(projection.actions.size, 0, "full must not add snapshot-only child disclosures");
  const compactImage = renderToolProjection({ toolCallId: "compact-media", toolName: "media", expanded: true,
    args: {}, result: { content: [], isError: false } }, 40, theme, {
    mode: "compact", nested, nestedExpanded: true, renderNative: () => nativeLines,
  });
  assert.ok(compactImage.lines.includes(image), "expanded compact panels preserve native image protocol verbatim");
  const owner = {};
  let appearance = "dark";
  const bg = (role) => `\x1b[48;5;${role === "toolErrorBg" ? 52 : appearance === "light" ? 250 : 236}m`;
  const panelTheme = { bold: (text) => text, fg: (_role, text) => text,
    bg: (role, text) => bg(role) + text + "\x1b[49m" };
  const panel = frameNativeRows("Assistant", ["ORIGINAL_ROW\x1b[0m TEXT"], 80, panelTheme, undefined, owner);
  assert.ok(panel.lines.every((line) => line.trimStart().startsWith(bg("toolPendingBg"))));
  assert.ok(panel.lines.every((line) => line.startsWith(" ") && line.endsWith(" ")), "outer gutters have terminal background, outside the panel fill");
  assert.ok(panel.lines.every((line) => visibleWidth(line) === 80));
  assert.equal(panel.inset, 3, "mouse offsets include margin and frame padding");
  assert.ok(panel.lines.some((line) => line.includes("\x1b[0m" + bg("toolPendingBg") + " TEXT")), "reset restores panel fill");
  assert.equal(frameNativeRows("Assistant", ["ORIGINAL_ROW\x1b[0m TEXT"], 80, panelTheme, undefined, owner), panel);
  appearance = "light";
  assert.notEqual(frameNativeRows("Assistant", ["ORIGINAL_ROW\x1b[0m TEXT"], 80, panelTheme, undefined, owner), panel);
  const source = ["CALL_ARGUMENTS", "RESULT_TEXT", image];
  const toolOwner = {};
  const combined = frameNativeToolRows("read", source, 40, panelTheme, 1, "success", toolOwner);
  const plain = combined.lines.map(stripTerminalSequences);
  assert.equal(plain.filter((line) => line.trimStart().startsWith("╭─")).length, 1);
  assert.equal(plain.filter((line) => line.trimStart().startsWith("╰")).length, 1);
  assert.ok(plain.some((line) => line.trimStart().startsWith("├─ Output")));
  assert.ok(!plain.includes("  │"));
  assert.deepEqual([...new Set(combined.sourceRows.values())], [0, 1, 2]);
  for (const [y, sourceY] of combined.sourceRows) {
    if (!plain[y].trimStart().startsWith("├─")) assert.ok(combined.lines[y].includes(source[sourceY]));
  }
  assert.ok(combined.lines.includes(image), "image payload and cursor placement remain verbatim");
  assert.equal(frameNativeToolRows("read", source, 40, panelTheme, 1, "success", toolOwner).lines, combined.lines);
  const failed = frameNativeToolRows("bash", ["command", "error detail"], 40, panelTheme, 1, "error", {}, "Took 1.2s");
  assert.ok(failed.lines.every((line) => line.trimStart().startsWith(bg("toolErrorBg"))));
  assert.ok(stripTerminalSequences(failed.lines.at(-1)).includes("Took 1.2s"));
  const pending = frameNativeToolRows("read", ["CALL_ONLY"], 40, panelTheme, undefined, {}, "");
  assert.ok(!pending.lines.map(stripTerminalSequences).some((line) => line.includes("Output")));
  const padded = ["", "arg A", "", "arg B", "", "", "out A", "", "out B", ""];
  const tight = frameNativeToolRows("edit", padded, 60, theme, 5, "success", {});
  assert.deepEqual([...new Set(tight.sourceRows.values())], [1, 2, 3, 6, 7, 8]);
  assert.ok(tight.lines.every((line) => visibleWidth(line) <= 60));
  const narrow = frameNativeToolRows("edit", ["call", "result"], 12, panelTheme, 1, "success", {});
  assert.ok(narrow.lines.every((line) => visibleWidth(line) <= 12));
  const tiny = frameNativeRows("tool", nativeLines, 5, panelTheme);
  assert.ok(tiny.lines.includes(image));
  // Background removal preserves foreground colors even when RGB channels
  // equal SGR background opcodes, and the panel fill survives embedded resets.
  assert.equal(stripAnsiBackgrounds("\x1b[1;38;2;40;49;100;48;2;1;2;3mX"), "\x1b[1;38;2;40;49;100mX");
  assert.equal(stripAnsiBackgrounds("\x1b[48:2::1:2:3;38:2::40:49:100mX"), "\x1b[38:2::40:49:100mX");
  const foreground = cardBackground("\x1b[38;2;0;0;0mX", 20, panelTheme);
  assert.ok(foreground.includes("\x1b[38;2;0;0;0mX"));
  assert.equal(foreground.split(bg("toolPendingBg")).length - 1, 1, "RGB zeros are not resets");
}

// Standalone compact projections share nested data and local actions,
// without borrowing clean's group ownership, coordinates, or collapse rows.
{
  const ctx = { hasUI: true, ui: { notify() {} } };
  const render = (tool, width = 100) => tool.render(width).map(stripTerminalSequences);
  const click = (tool, needle, dx = 0) => {
    const rows = render(tool);
    const y = rows.findIndex((line) => line.includes(needle));
    assert.ok(y >= 0, rows.join("\n"));
    if (dx) mouseGestureFixture(tool, rows, 100).gesture(12, y, [[dx, 0]]);
    else tool.handleMouse({ type: "click", button: "left", x: 12, y, width: 100, height: rows.length });
  };
  const nativeDefinition = {
    renderShell: "self", label: "Wrapper Label",
    renderCall: () => new Text("\x1b[44mNATIVE ROOT SCRIPT\x1b[49m", 0, 0),
    renderResult: (r) => new Text(r.content.map((c) => c.text ?? "").join("\n"), 0, 0),
  };
  for (const mode of ["compact"]) {
    await commands.get("pretty-tui").handler(mode, ctx);
    await emit("session_start", {}, sessionContext([]));
    await emit("agent_start");
    const id = `standalone-${mode}`;
    let redraws = 0;
    const root = new ToolExecutionComponent("custom-wrapper", id, { code: "SHARED_SCRIPT_BODY" }, undefined,
      nativeDefinition, { requestRender() { redraws++; } }, process.cwd());
    root.markExecutionStarted(); root.render(100);
    for (const [child, name] of [["1", "read"], ["2", "remote"]]) {
      await emit("tool_execution_start", { toolCallId: `${id}/${child}`, parentToolCallId: id, toolName: name, args: { path: "fixture.txt" } });
    }
    assert.ok(redraws > 1, "nested updates request the owning component's UI in every mode");
    let rows = render(root);
    assert.ok(rows.some((line) => line.includes("read(")));
    assert.ok(rows.some((line) => line.includes("remote(")));
    assert.ok(!rows.some((line) => /(?:Running|Done)\(\d+ tool calls/.test(line)));
    assert.ok(!rows.join("\n").includes("[↑ Collapse]"));
    // Finish out of order; rows must remain in launch order and errors visible.
    for (const child of ["2", "1"]) {
      await emit("tool_execution_end", { toolCallId: `${id}/${child}`, parentToolCallId: id,
        toolName: child === "1" ? "read" : "remote", isError: child === "2",
        result: { content: [{ type: "text", text: child === "1" ? "Read fixture\nSHARED_CHILD_DETAIL" : "Permission denied\nSHARED_ERROR_DETAIL" }] } });
    }
    const rootResult = { content: [{ type: "text", text: "SHARED_PARENT_OUTPUT" }], isError: false };
    await emit("tool_execution_end", { toolCallId: id, toolName: "custom-wrapper", result: rootResult, isError: false });
    root.updateResult(rootResult);
    rows = render(root);
    assert.ok(rows.findIndex((line) => line.includes("read(")) < rows.findIndex((line) => line.includes("remote(")));
    assert.ok(rows.join("\n").includes("Permission denied"));
    assert.equal(rows.join("\n").includes("SHARED_CHILD_DETAIL"), false);
    click(root, "read(", 2);
    assert.equal(render(root).join("\n").includes("SHARED_CHILD_DETAIL"), true);
    assert.equal(render(root).join("\n").includes("SHARED_ERROR_DETAIL"), false, "local disclosure does not toggle its sibling");
    const host = { ui: { requestRender() {} }, chatContainer: { children: [root] },
      loadedResourcesContainer: { children: [] }, toolOutputExpanded: false, showStatus() {},
      setToolsExpanded: InteractiveMode.prototype.setToolsExpanded };
    InteractiveMode.prototype.setToolsExpanded.call(host, true);
    assert.ok(render(root).join("\n").includes("SHARED_CHILD_DETAIL"));
    assert.ok(render(root).join("\n").includes("SHARED_ERROR_DETAIL"));
    click(root, "SHARED_CHILD_DETAIL");
    assert.ok(!render(root).join("\n").includes("SHARED_CHILD_DETAIL"));
    assert.ok(render(root).join("\n").includes("SHARED_ERROR_DETAIL"));
    InteractiveMode.prototype.setToolsExpanded.call(host, false);
    assert.ok(!render(root).join("\n").includes("SHARED_ERROR_DETAIL"));
    InteractiveMode.prototype.toggleToolOutputExpansion.call(host);
    assert.ok(render(root).join("\n").includes("SHARED_CHILD_DETAIL"), "native Ctrl+O route resets local overrides");

    assert.ok(render(root).join("\n").includes("SHARED_SCRIPT_BODY"));
    assert.ok(render(root).join("\n").includes("SHARED_PARENT_OUTPUT"));
    click(root, "SHARED_SCRIPT_BODY");
    assert.ok(!render(root).join("\n").includes("SHARED_SCRIPT_BODY"));
    click(root, "SHARED_PARENT_OUTPUT");
    assert.ok(!render(root).join("\n").includes("SHARED_PARENT_OUTPUT"));
    for (const width of [1, 12, 40]) assert.ok(render(root, width).every((line) => visibleWidth(line) <= width));

    // A mode change must not retain standalone hit regions or insert a
    // phantom activity row when clean takes ownership of the same component.
    await commands.get("pretty-tui").handler("clean", ctx);
    const cleanRows = render(root);
    assert.ok(cleanRows.some((line) => /(?:Running|Done)\(/.test(line)));
    await commands.get("pretty-tui").handler(mode, ctx);
    assert.ok(!render(root).some((line) => /(?:Running|Done)\(\d+ tool calls/.test(line)));
    const saved = appendedEntries.findLast((entry) => entry.type === "pretty-tui-nested-results" && entry.data.rootId === id);
    assert.ok(saved);
    await emit("session_start", {}, sessionContext([
      assistant("90", undefined, [{ id, name: "custom-wrapper" }]),
      { type: "custom", customType: saved.type, data: saved.data },
    ]));
    const restored = new ToolExecutionComponent("custom-wrapper", id, {}, undefined, nativeDefinition, { requestRender() {} }, process.cwd());
    restored.updateResult(rootResult);
    assert.ok(render(restored).join("\n").includes("Permission denied"));
    click(restored, "read(");
    assert.ok(render(restored).join("\n").includes("SHARED_CHILD_DETAIL"));

    // A third-party replacement under a built-in name is not specialized.
    const third = new ToolExecutionComponent("grep", `${id}-third`, { path: "source.ts" }, undefined,
      { label: "Custom Search", renderCall: () => new Text("THIRD_NATIVE_DETAIL", 0, 0) }, { requestRender() {} }, process.cwd());
    third.updateResult({ content: [{ type: "text", text: "Third result\nTHIRD_RESULT_DETAIL" }], isError: true });
    const thirdRows = render(third);

    assert.ok(thirdRows.join("\n").includes("Custom Search"));
    assert.ok(thirdRows.join("\n").includes("path=source.ts"));
    assert.ok(!thirdRows.join("\n").includes("THIRD_NATIVE_DETAIL"));
    click(third, "Custom Search", -2);
    assert.ok(render(third).join("\n").includes("THIRD_NATIVE_DETAIL"));
    for (const width of [1, 12, 40]) assert.ok(render(third, width).every((line) => visibleWidth(line) <= width));
    click(third, "Custom Search");
    assert.ok(!render(third).join("\n").includes("THIRD_NATIVE_DETAIL"));

    let nativeMouse;
    const interactive = new ToolExecutionComponent("interactive-tool", `${id}-interactive`, {}, undefined,
      { renderShell: "self", renderCall: () => ({
        render: () => ["NATIVE_BUTTON"], invalidate() {},
        handleMouse(event) { nativeMouse = event; return { handled: true }; },
      }) }, { requestRender() {} }, process.cwd());
    interactive.setExpanded(true);
    const interactiveRows = render(interactive);
    const nativeY = interactiveRows.findIndex((line) => line.includes("NATIVE_BUTTON"));
    assert.ok(nativeY >= 0);
    interactive.handleMouse({ type: "click", button: "left", x: 12, y: nativeY, width: 100, height: interactiveRows.length });
    assert.equal(nativeMouse?.y, 0, "native interaction keeps its own local row coordinates");
    assert.equal(nativeMouse?.x, mode === "compact" ? 9 : 5);
    assert.equal(nativeMouse?.width, mode === "compact" ? 94 : 90);
    await emit("session_start", {}, sessionContext([]));
    await emit("tool_execution_start", { toolCallId: `${id}/cancel`, parentToolCallId: id, toolName: "wait", args: {} });
    await emit("agent_settled");
    const cancelled = new ToolExecutionComponent("custom-wrapper", id, {}, undefined, nativeDefinition, { requestRender() {} }, process.cwd());
    assert.match(render(cancelled).join("\n"), /⊘ wait/);
  }
  await commands.get("pretty-tui").handler("clean", ctx);
}

// Compaction cards preserve the native token notice, summary and expansion API.
{
  const ctx = { hasUI: true, ui: { notify() {} } };
  const message = { role: "compactionSummary", tokensBefore: 485574,
    summary: "COMPACTION_DETAIL\n\n- Preserve this summary", timestamp: 0 };
  const component = new CompactionSummaryMessageComponent(message);
  const render = (width = 80) => component.render(width).map(stripTerminalSequences);
  for (const mode of ["compact", "full"]) {
    await commands.get("pretty-tui").handler(mode, ctx);
    component.setExpanded(false);
    let rows = render();
    assert.ok(rows[0].includes("compaction ▸"));
    assert.ok(rows.join("\n").includes("485,574"));
    assert.ok(rows.join("\n").includes("to expand"));
    assert.ok(!rows.join("\n").includes("COMPACTION_DETAIL"));
    assert.ok(!rows.join("\n").includes("[compaction]"));
    assert.equal(component.handleMouse({ type: "click", button: "left", x: 5, y: 0, width: 80, height: rows.length })?.handled, true);
    rows = render();
    assert.ok(rows[0].includes("compaction ▾"));
    assert.ok(rows.join("\n").includes("COMPACTION_DETAIL"));
    assert.ok(rows.join("\n").includes("485,574"));
    const y = rows.findIndex((line) => line.includes("COMPACTION_DETAIL"));
    component.handleMouse({ type: "click", button: "left", x: 6, y, width: 80, height: rows.length });
    assert.equal(component.expanded, false);
    component.setExpanded(true);
    for (const width of [1, 8, 12, 40, 80]) assert.ok(render(width).every((line) => visibleWidth(line) <= width));
    component.setExpanded(false);
    assert.ok(!render().join("\n").includes("COMPACTION_DETAIL"));
  }
  await commands.get("pretty-tui").handler("clean", ctx);
  assert.ok(render().join("\n").includes("[compaction]"));
  assert.equal(component.message, message, "card presentation does not mutate compaction data");
}

// Compact panels keep summaries small and expose details via local/global
// expansion without adopting clean's activity-group wrapper.
{
  const ctx = { hasUI: true, ui: { notify() {} } };
  await commands.get("pretty-tui").handler("compact", ctx);
  await emit("session_start", {}, sessionContext([]));
  const definitions = [
    ["read", { path: "sample.ts" }, "FIRST_LINE\nPRIVATE_READ_DETAIL", {}],
    ["bash", { command: "npm test" }, "FIRST_LINE\nPRIVATE_BASH_DETAIL", {}],
    ["write", { path: "sample.ts", content: "PRIVATE_WRITE_DETAIL" }, "Written", {}],
    ["edit", { path: "sample.ts", edits: [{ oldText: "before", newText: "after" }] }, "Updated", { diff: "-1 before\n+1 PRIVATE_EDIT_DETAIL" }],
  ];
  const components = [];
  const render = (tool, width = 100) => tool.render(width).map(stripTerminalSequences);
  for (const [name, args, output, details] of definitions) {
    const tool = new ToolExecutionComponent(name, `compact-panel-${name}`, args, undefined, tools.get(name), { requestRender() {} }, process.cwd());
    tool.updateResult({ content: [{ type: "text", text: output }], details, isError: false, durationMs: 1200 });
    components.push(tool);
    const collapsed = render(tool);
    assert.ok(collapsed.some((line) => line.trimStart().startsWith(`╭─ ${name}`)));
    assert.ok(collapsed.some((line) => line.includes(`${name} ▸`)), "collapsed title indicates expansion");
    assert.ok(collapsed.length <= 6, `${name}: default panel stays concise`);
    assert.ok(!collapsed.join("\n").includes("PRIVATE_"));
    assert.ok(!collapsed.join("\n").includes(`${name}(`), "panel title replaces the repeated tool name in the summary");
    assert.ok(collapsed.at(-1).includes("Took 1.2s"));
    const y = collapsed.findIndex((line) => line.includes(`╭─ ${name}`));
    tool.handleMouse({ type: "click", button: "left", x: 6, y, width: 100, height: collapsed.length });
    assert.equal(tool.expanded, true);
    assert.ok(render(tool).join("\n").includes("PRIVATE_"));
    if (name !== "write") assert.ok(render(tool).some((line) => line.includes("├─ Output")), name);
    assert.ok(render(tool).some((line) => line.includes(`${name} ▾`)), "expanded title indicates collapse");
    const compactDetails = render(tool).slice(1);
    // The disclosure belongs to compact; all detail rows still match full.
    compactDetails[0] = compactDetails[0].replace(" ▾", "").replace(/─╮/, "───╮");
    await commands.get("pretty-tui").handler("full", ctx);
    assert.deepEqual(render(tool).slice(2), compactDetails, `${name}: expanded compact matches full exactly`);
    await commands.get("pretty-tui").handler("compact", ctx);
    const opened = render(tool);
    tool.handleMouse({ type: "click", button: "left", x: 6, y, width: 100, height: opened.length });
    assert.equal(tool.expanded, false);
    assert.ok(!render(tool).join("\n").includes("PRIVATE_"));
    for (const width of [8, 12, 40]) assert.ok(render(tool, width).every((line) => visibleWidth(line) <= width));
  }
  const longCommand = 'rg -n "accent" extensions/full-frame.ts extensions/tool-presentation.ts; rg -n "title|accent|success" tests/regression.mjs | tail -12';
  const wrappedBash = new ToolExecutionComponent("bash", "compact-wrapped-bash", { command: longCommand }, undefined, tools.get("bash"), { requestRender() {} }, process.cwd());
  wrappedBash.updateResult({ content: [{ type: "text", text: "Done" }], isError: false });
  for (const width of [40, 80, 100]) {
    const rows = render(wrappedBash, width);
    assert.ok(rows.some((line) => line.includes("$ rg")), "wrapped command retains shell prompt");
    assert.ok(!rows.join("\n").includes("●"), "wrapped compact call has no old dot");
    assert.ok(!rows.join("\n").includes("bash("), "wrapped compact call has no repeated name");
    assert.ok(rows.some((line) => line.includes("✓ Done")), "result summary is styled even after a multiline call");
    assert.ok(!rows.join("\n").includes("└"));
    assert.ok(rows.every((line) => visibleWidth(line) <= width));
  }
  const host = { ui: { requestRender() {} }, chatContainer: { children: components }, loadedResourcesContainer: { children: [] },
    toolOutputExpanded: false, showStatus() {}, setToolsExpanded: InteractiveMode.prototype.setToolsExpanded };
  InteractiveMode.prototype.toggleToolOutputExpansion.call(host);
  assert.ok(components.every((tool) => tool.expanded));
  InteractiveMode.prototype.toggleToolOutputExpansion.call(host);
  assert.ok(components.every((tool) => !tool.expanded));
  const message = { role: "assistant", timestamp: "compact-panel-thought", content: [
    { type: "thinking", thinking: "COMPACT_FIRST_LINE\nPRIVATE_COMPACT_THOUGHT" }, { type: "text", text: "VISIBLE_COMPACT_REPLY" },
  ] };
  const thought = new AssistantMessageComponent(message);
  let thoughtRows = render(thought);
  assert.ok(thoughtRows.some((line) => line.includes("thought ▸")));
  assert.ok(thoughtRows.some((line) => line.includes("COMPACT_FIRST_LINE")), "collapsed thought previews its first content line");
  assert.ok(!thoughtRows.join("\n").includes("PRIVATE_COMPACT_THOUGHT"));
  assert.ok(thoughtRows.some((line) => line.includes("╭─ Assistant")));
  const thoughtY = thoughtRows.findIndex((line) => line.includes("COMPACT_FIRST_LINE"));
  thought.handleMouse({ type: "click", button: "left", x: 6, y: thoughtY, width: 100, height: thoughtRows.length });
  thoughtRows = render(thought);
  assert.ok(thoughtRows.join("\n").includes("PRIVATE_COMPACT_THOUGHT"));
  assert.ok(thoughtRows.some((line) => line.includes("thought ▾")));
  assert.equal(thoughtRows.filter((line) => line.includes("VISIBLE_COMPACT_REPLY")).length, 1);
  const writes = [];
  const visibilityHost = {
    hideThinkingBlock: false,
    settingsManager: { setHideThinkingBlock(value) { writes.push(value); } },
    chatContainer: { children: [thought] }, ui: { requestRender() {} }, showStatus() {},
    updateThinkingBlockVisibility: InteractiveMode.prototype.updateThinkingBlockVisibility,
  };
  InteractiveMode.prototype.toggleThinkingBlockVisibility.call(visibilityHost);
  assert.ok(render(thought).join("\n").includes("PRIVATE_COMPACT_THOUGHT"));
  InteractiveMode.prototype.toggleThinkingBlockVisibility.call(visibilityHost);
  assert.ok(!render(thought).join("\n").includes("PRIVATE_COMPACT_THOUGHT"));
  assert.deepEqual(writes, [false, true], "Ctrl+T follows compact's initially collapsed visibility");
  await commands.get("pretty-tui").handler("clean", ctx);
}

// Full cards delegate to native built-in renderers and retain their information
// at the same content width. Native expansion, third-party clicks and separate
// thinking runs remain owned by Pi, not the compact activity projection.
{
  const runtime = await import("@earendil-works/pi-coding-agent");
  const ctx = { hasUI: true, ui: { notify() {} } };
  await commands.get("pretty-tui").handler("full", ctx);
  await emit("session_start", {}, sessionContext([]));
  const nativeRender = originalPrototypeMethods.find(([name]) => name === "ToolExecutionComponent.render")[3];
  const { stripAnsiBackgrounds } = await jiti.import(join(process.cwd(), "extensions/ansi-style.ts"));
  const normalize = (lines) => lines.map(stripTerminalSequences).map((line) => line.trim()).filter(Boolean);
  const cases = [
    ["read", runtime.createReadToolDefinition, { path: "source.ts", offset: 10, limit: 5 }, "const answer = 42;\nconsole.log(answer);", {}],
    ["bash", runtime.createBashToolDefinition, { command: "printf 'alpha\\nbeta\\n'" }, "alpha\nbeta\n", { exitCode: 0 }],
    ["edit", runtime.createEditToolDefinition, { path: "fixture.ts", edits: [{ oldText: "before", newText: "after" }] }, "Successfully replaced text", { diff: "-1 before\n+1 after", firstChangedLine: 1 }],
    ["write", runtime.createWriteToolDefinition, { path: "notes.txt", content: Array.from({ length: 20 }, (_, i) => `LINE_${i}`).join("\n") }, "Successfully wrote notes.txt", {}],
    ["grep", runtime.createGrepToolDefinition, { pattern: "answer", path: "." }, "source.ts:10:const answer = 42;", {}],
    ["find", runtime.createFindToolDefinition, { pattern: "*.ts", path: "." }, "source.ts\nfixture.ts", {}],
    ["ls", runtime.createLsToolDefinition, { path: "." }, "source.ts\nnotes.txt", {}],
  ];
  for (const [name, factory, args, text, details] of cases) {
    const nativeDefinition = factory(process.cwd());
    const tool = new ToolExecutionComponent(name, `full-card-${name}`, args, undefined, tools.get(name), { requestRender() {} }, process.cwd());
    const baseline = new ToolExecutionComponent(name, `native-card-${name}`, args, undefined, nativeDefinition, { requestRender() {} }, process.cwd());
    const toolResult = { content: [{ type: "text", text }], details, isError: false, durationMs: 1234 };
    tool.updateResult(toolResult); baseline.updateResult(toolResult);
    const host = { ui: { requestRender() {} }, chatContainer: { children: [tool] }, loadedResourcesContainer: { children: [] }, toolOutputExpanded: false, showStatus() {} };
    for (const expanded of [false, true, false]) {
      InteractiveMode.prototype.setToolsExpanded.call(host, expanded);
      baseline.setExpanded(expanded);
      const rows = tool.render(100).map(stripTerminalSequences);
      assert.ok(rows[2].includes(`╭─ ${name}`), rows.join("\n"));
      assert.equal(rows.filter((line) => line.trimStart().startsWith("╭─")).length, 1, name);
      assert.ok(rows[2].includes(`╭─ ${name} `));
      // Our registered tools render their own shell. The native default shell
      // contributes two extra padding columns, so compare equal content widths.
      const nativeWidth = nativeDefinition.renderShell === "self" ? 94 : 96;
      assert.deepEqual(normalize(tool.selfRenderContainer.render(94)), normalize(nativeRender.call(baseline, nativeWidth)), name);
      assert.ok(!rows.join("\n").includes("nested calls"));
      assert.ok(!rows.join("\n").includes("Updated ·"));
    }
    const fullRows = tool.render(100);
    if (name === "edit") {
      const plain = fullRows.map(stripTerminalSequences);
      assert.equal(plain.filter((line) => line.trimStart().startsWith("╭─")).length, 1);
      assert.ok(!plain.includes("  │"));
      assert.ok(plain.some((line) => line.trimStart().startsWith("├─ Output")));
    }
    if (name === "read") {
      const y = fullRows.map(stripTerminalSequences).findIndex((line) => line.includes("source.ts"));
      tool.handleMouse({ type: "click", button: "left", x: 8, y, width: 100, height: fullRows.length });
      assert.equal(tool.expanded, true, "native call click still expands the result inside the frame");
      assert.ok(tool.render(100).map(stripTerminalSequences).join("\n").includes("console.log(answer)"));
      const expandedRows = tool.render(100).map(stripTerminalSequences);
      assert.equal(expandedRows.filter((line) => line.trimStart().startsWith("╭─")).length, 1);
      assert.ok(expandedRows.some((line) => line.trimStart().startsWith("├─ Output")));
      const resultY = expandedRows.findIndex((line) => line.includes("console.log(answer)"));
      tool.handleMouse({ type: "click", button: "left", x: 8, y: resultY, width: 100, height: expandedRows.length });
      assert.equal(tool.expanded, false, "result-card click maps back to the native result region");
      assert.equal(tool.render(100).map(stripTerminalSequences).filter((line) => line.trimStart().startsWith("╭─")).length, 1);
    }
  }
  for (const command of [
    ["node --input-type=module <<'JS'", "import {initTheme} from '@earendil-works/pi-coding-agent';", "console.log('Pi theme color mode:');", "JS"].join("\n"),
    ["python3 - <<'PY'", "from pathlib import Path", "p=Path('README.md');s=p.read_text().replace('old', 'new')", "p.write_text(s)", "PY", "npm pack --dry-run && git diff --check"].join("\n"),
  ]) {
    const nativeOnly = new ToolExecutionComponent("bash", "native-heredoc-highlight", { command, timeout: 10 }, undefined,
      runtime.createBashToolDefinition(process.cwd()), { requestRender() {} }, process.cwd());
    nativeOnly.render(100);
    const expected = runtime.highlightCode(command, "bash").join("\n");
    assert.notEqual(expected, command);
    assert.ok(nativeOnly.callRendererComponent.text.includes(expected), "native/history renderer path must get full-mode shell highlighting too");
    assert.equal(stripTerminalSequences(nativeOnly.callRendererComponent.text), `$ ${command} (timeout 10s)`);
  }
  const shellSource = [
    'if [ -n "$HOME" ]; then',
    '  printf "%s\\n" "$HOME" # keep comment',
    'fi',
  ].join("\n");
  const shellArgs = Object.freeze({ command: shellSource, timeout: 12 });
  const highlightedShell = new ToolExecutionComponent("bash", "full-shell-colors", shellArgs, undefined, tools.get("bash"), { requestRender() {} }, process.cwd());
  highlightedShell.render(100);
  const callText = highlightedShell.callRendererComponent.text;
  assert.equal(stripTerminalSequences(callText), `$ ${shellSource} (timeout 12s)`, "highlighting preserves native prompt, command, whitespace and timeout");
  const expectedHighlight = runtime.highlightCode(shellSource, "bash").join("\n");
  assert.notEqual(expectedHighlight, shellSource, "fixture contains real shell syntax colors");
  assert.ok(callText.includes(expectedHighlight));
  assert.ok(new Set(callText.match(/\x1b\[(?:38;[^m]+|3[0-7]|9[0-7])m/g)).size >= 3);
  assert.equal(highlightedShell.args, shellArgs, "execution arguments remain unchanged");
  for (const command of ["[", "$", " ", "if", "printf '%s' m"]) {
    highlightedShell.updateArgs({ command });
    highlightedShell.render(100);
    assert.equal(stripTerminalSequences(highlightedShell.callRendererComponent.text), `$ ${command}`, "short streamed commands must not replace ANSI prefixes or the shell prompt");
  }
  highlightedShell.updateArgs({ command: 'echo "$UNFINISHED', timeout: 12 });
  highlightedShell.render(100);
  assert.equal(stripTerminalSequences(highlightedShell.callRendererComponent.text), '$ echo "$UNFINISHED (timeout 12s)', "incomplete streamed syntax remains visible");
  highlightedShell.updateArgs({ command: null });
  highlightedShell.render(100);
  assert.ok(stripTerminalSequences(highlightedShell.callRendererComponent.text).includes("..."));
  highlightedShell.updateArgs({ command: {} });
  highlightedShell.render(100);
  assert.ok(stripTerminalSequences(highlightedShell.callRendererComponent.text).includes("[invalid arg]"));
  const answerOnly = new AssistantMessageComponent({ role: "assistant", timestamp: "full-answer-region", content: [
    { type: "text", text: "REPLY_CLICK_TARGET" }, { type: "text", text: "SECOND_REPLY_BLOCK" },
  ] });
  let replyMouse;
  const nativeReply = answerOnly.contentContainer.children.find((child) => child instanceof Markdown);
  nativeReply.handleMouse = (event) => { replyMouse = event; return { handled: true }; };
  const answerRows = answerOnly.render(100).map(stripTerminalSequences);
  const headingY = answerRows.findIndex((line) => line.trimStart().startsWith("╭─ Assistant "));
  const replyY = answerRows.findIndex((line) => line.includes("REPLY_CLICK_TARGET"));
  assert.ok(headingY >= 1 && answerRows[headingY - 1] === "");
  assert.ok(answerRows[headingY + 1].trimStart().startsWith("│"));
  assert.ok(answerRows.at(-1).trimStart().startsWith("╰"));
  assert.equal(answerRows.filter((line) => line.trimStart().startsWith("╭─ Assistant ")).length, 1, "one response card for consecutive text blocks");
  assert.ok(answerRows.join("\n").includes("SECOND_REPLY_BLOCK"));
  answerOnly.handleMouse({ type: "click", button: "left", x: 10, y: replyY, width: 100, height: answerRows.length });
  assert.equal(replyMouse.y, 0, "answer decoration keeps native Markdown hit coordinates");
  assert.equal(replyMouse.x, 7);
  assert.equal(replyMouse.width, 94);
  const realClock = Date.now;
  let timerNow = 5000;
  Date.now = () => timerNow;
  const timed = new ToolExecutionComponent("bash", "full-border-timer", { command: "echo timer" }, undefined, tools.get("bash"), { requestRender() {} }, process.cwd());
  try {
    timed.markExecutionStarted();
    timerNow = 7000;
    timed.updateResult({ content: [{ type: "text", text: "Took 2.0s\nUSER_OUTPUT_MUST_REMAIN" }], isError: false }, true);
    let timerRows = timed.render(100).map(stripTerminalSequences);
    assert.ok(timerRows.at(-1).includes("Elapsed 2.0s"));
    assert.ok(timerRows.at(-1).trimStart().startsWith("╰"));
    assert.ok(!timerRows.slice(0, -1).some((line) => line.includes("Elapsed 2.0s")));
    timed.updateResult({ content: [{ type: "text", text: "Took 2.0s\nUSER_OUTPUT_MUST_REMAIN" }], isError: false, durationMs: 2000 });
    timerRows = timed.render(100).map(stripTerminalSequences);
    assert.ok(timerRows.at(-1).includes("Took 2.0s"));
    assert.equal(timerRows.filter((line) => line.includes("Took 2.0s")).length, 2, "a user output line identical to the timer must remain");
    assert.ok(timerRows.some((line) => line.includes("USER_OUTPUT_MUST_REMAIN")));
    const narrowTimer = timed.render(12).map(stripTerminalSequences).join("\n");
    assert.ok(narrowTimer.includes("Took"), "when the border cannot fit timing, keep native timing in the body");
    const resultRow = timerRows.findIndex((line) => line.includes("USER_OUTPUT_MUST_REMAIN"));
    timed.handleMouse({ type: "click", button: "left", x: 6, y: resultRow, width: 100, height: timerRows.length });
    assert.equal(timed.expanded, true, "moved timer and background panels preserve native mouse offsets");
  } finally {
    Date.now = realClock;
  }
  const unknown = new ToolExecutionComponent("history-only", "full-unknown", { query: "EXACT_ARGUMENT" }, undefined, undefined, { requestRender() {} }, process.cwd());
  unknown.updateResult({ content: [{ type: "text", text: "EXACT_RESULT" }], isError: false });
  const unknownRows = unknown.render(100).map(stripTerminalSequences).join("\n");
  assert.ok(unknownRows.includes("╭─ history-only "));
  assert.ok(unknownRows.includes("├─ Output"));
  assert.ok(unknownRows.includes("EXACT_ARGUMENT"));
  assert.ok(unknownRows.includes("EXACT_RESULT"));
  let nativeClick;
  const interactive = new ToolExecutionComponent("third-party", "full-native-button", {}, undefined, {
    renderShell: "self", renderCall: () => ({ render: () => ["THIRD_PARTY_BUTTON"], invalidate() {},
      handleMouse(event) { nativeClick = event; return { handled: true }; } }),
  }, { requestRender() {} }, process.cwd());
  let rows = interactive.render(100).map(stripTerminalSequences);
  interactive.handleMouse({ type: "click", button: "left", x: 12, y: rows.findIndex((line) => line.includes("THIRD_PARTY_BUTTON")), width: 100, height: rows.length });
  assert.equal(nativeClick.y, 0); assert.equal(nativeClick.x, 9); assert.equal(nativeClick.width, 94);
  let resultClick;
  const interactiveResult = new ToolExecutionComponent("custom-result", "full-output-button", {}, undefined, {
    renderShell: "self", renderCall: () => new Text("CALL_REGION", 0, 0),
    renderResult: () => Object.assign(new Text("BTN_OK\n" + "长结果内容 ".repeat(30), 0, 0), {
      handleMouse(event) { resultClick = event; return { handled: true }; },
    }),
  }, { requestRender() {} }, process.cwd());
  interactiveResult.updateResult({ content: [{ type: "text", text: "result" }], isError: false });
  for (const width of [12, 16, 40, 100]) {
    const resultRows = interactiveResult.render(width).map(stripTerminalSequences);
    assert.ok(resultRows.every((line) => visibleWidth(line) <= width));
    const y = resultRows.findIndex((line) => line.includes("BTN_OK"));
    if (width >= 16) {
      assert.ok(resultRows.some((line) => line.trimStart().startsWith("├─ Output")));
      interactiveResult.handleMouse({ type: "click", button: "left", x: 12, y, width, height: resultRows.length });
      assert.equal(resultClick.x, width >= 20 ? 9 : 10, "output click subtracts the shared frame padding");
      assert.equal(resultClick.y, 0);
      assert.equal(resultClick.width, width - 4 - (width >= 20 ? 2 : 0));
    }
  }
  const message = { role: "assistant", timestamp: "full-native-runs", content: [
    { type: "thinking", thinking: "FIRST_NATIVE_THOUGHT" }, { type: "text", text: "FIRST_NATIVE_ANSWER" },
    { type: "thinking", thinking: "SECOND_NATIVE_THOUGHT" }, { type: "text", text: "SECOND_NATIVE_ANSWER" },
  ] };
  const thought = new AssistantMessageComponent(message);
  const renderThought = () => thought.render(100).map(stripTerminalSequences);
  rows = renderThought();
  assert.equal(rows.filter((line) => line.includes("╭─ thought")).length, 2);
  const joined = rows.join("\n");
  assert.ok(joined.indexOf("FIRST_NATIVE_THOUGHT") < joined.indexOf("FIRST_NATIVE_ANSWER"));
  assert.ok(joined.indexOf("FIRST_NATIVE_ANSWER") < joined.indexOf("SECOND_NATIVE_THOUGHT"));
  thought.handleMouse({ type: "click", button: "left", x: 6, y: rows.findIndex((line) => line.includes("╭─ thought")), width: 100, height: rows.length });
  assert.ok(!renderThought().join("\n").includes("FIRST_NATIVE_THOUGHT"));
  assert.ok(renderThought().join("\n").includes("SECOND_NATIVE_THOUGHT"));
  assert.ok(renderThought().join("\n").includes("FIRST_NATIVE_ANSWER"));
  thought.setHideThinkingBlock(true);
  assert.ok(!renderThought().join("\n").includes("SECOND_NATIVE_THOUGHT"));
  thought.setHideThinkingBlock(false);
  assert.ok(renderThought().join("\n").includes("FIRST_NATIVE_THOUGHT"));
  // A saved hidden setting must not silently fold full's initial thought.
  const initiallyHidden = new AssistantMessageComponent({ ...message, timestamp: "full-default-open" }, true);
  assert.ok(initiallyHidden.render(100).map(stripTerminalSequences).join("\n").includes("FIRST_NATIVE_THOUGHT"));
  const visibilityWrites = [];
  const visibilityHost = {
    hideThinkingBlock: true,
    settingsManager: { setHideThinkingBlock(value) { visibilityWrites.push(value); } },
    chatContainer: { children: [initiallyHidden] }, ui: { requestRender() {} }, showStatus() {},
    updateThinkingBlockVisibility: InteractiveMode.prototype.updateThinkingBlockVisibility,
  };
  InteractiveMode.prototype.toggleThinkingBlockVisibility.call(visibilityHost);
  assert.ok(!initiallyHidden.render(100).map(stripTerminalSequences).join("\n").includes("FIRST_NATIVE_THOUGHT"));
  InteractiveMode.prototype.toggleThinkingBlockVisibility.call(visibilityHost);
  assert.ok(initiallyHidden.render(100).map(stripTerminalSequences).join("\n").includes("FIRST_NATIVE_THOUGHT"));
  assert.deepEqual(visibilityWrites, [true, false]);
  await commands.get("pretty-tui").handler("clean", ctx);
}

// When testing against modern Pi, execute an actual QuickJS codemode script
// through Pi's nested runner, not only hand-written UI events. The project's
// older baseline has no codemode export and intentionally skips this block.
{
  const runtime = await import("@earendil-works/pi-coding-agent");
  if (typeof runtime.createCodemodeExtension === "function") {
    const { NestedToolCallRunner } = await import(new URL("./core/nested-tool-calls.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    await emit("session_start", {}, sessionContext([]));
    await emit("agent_start");
    let definition;
    runtime.createCodemodeExtension({ models: false })({
      registerTool(tool) { definition = tool; }, appendEntry() {},
      getAllTools: () => [], getSettings: () => ({}),
    });
    const callable = [{ name: "fixture", label: "fixture", description: "Return a text fixture",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
    const runner = new NestedToolCallRunner({
      getTools: () => callable, isSequential: () => false,
      emit: (event) => emit(event.type, event),
      runToolCall: async (toolCall) => ({ toolCall, isError: false,
        result: { content: [{ type: "text", text: `Read ${toolCall.arguments.path}\nNATIVE NESTED DETAIL` }] } }),
    });
    const parentId = "native-codemode";
    const args = { code: 'const r = await Promise.all([tools.fixture({path:"one.txt"}), tools.fixture({path:"two.txt"})]); text("FINAL ONLY");' };
    const tool = new ToolExecutionComponent("codemode", parentId, args, undefined, definition,
      { requestRender() {} }, process.cwd());
    tool.markExecutionStarted(); tool.render(100);
    await emit("tool_execution_start", { toolCallId: parentId, toolName: "codemode", args });
    const output = await definition.execute(parentId, args, new AbortController().signal,
      async (partialResult) => {
        tool.updateResult({ ...partialResult, isError: false }, true);
        await emit("tool_execution_update", { toolCallId: parentId, toolName: "codemode", args, partialResult });
      }, {
        tools: callable, sessionManager: { getBranch: () => [] },
        executeTool: (name, parameters, options) => runner.execute(parentId, name, parameters, options),
      });
    assert.match(output.content.map((block) => block.text ?? "").join("\n"), /FINAL ONLY/);
    assert.equal(output.details.calls.length, 2);
    await emit("tool_execution_end", { toolCallId: parentId, toolName: "codemode", result: output, isError: false });
    tool.updateResult({ ...output, isError: false }); tool.setExpanded(true);
    let lines = tool.render(100).map(stripTerminalSequences);
    assert.match(lines.join("\n"), /(?:Running|Done)\(3 tool calls/);
    assert.ok(lines.some((line) => line.includes("fixture(path=one.txt)")));
    assert.ok(lines.some((line) => line.includes("fixture(path=two.txt)")));
    assert.ok(!lines.join("\n").includes("NATIVE NESTED DETAIL"));
    const y = lines.findIndex((line) => line.includes("fixture(path=one.txt)"));
    tool.handleMouse({ type: "click", button: "left", x: 14, y, width: 100, height: lines.length });
    assert.match(tool.render(100).map(stripTerminalSequences).join("\n"), /NATIVE NESTED DETAIL/);
    assert.equal(tool.render(100).map(stripTerminalSequences).at(-1), "  └─ [↑ Collapse]");
    const commandContext = { hasUI: true, ui: { notify() {} } };
    for (const mode of ["full", "compact"]) {
      await commands.get("pretty-tui").handler(mode, commandContext);
      const rows = tool.render(100).map(stripTerminalSequences);
      const sharedLines = rows.join("\n");
      assert.ok(!/(?:Running|Done)\(\d+ tool calls/.test(sharedLines));
      if (mode === "full") {
        assert.match(sharedLines, /FINAL ONLY/);
        assert.ok(rows.at(-1).trimStart().startsWith("╰") && rows.at(-1).includes("Took"), "native codemode duration moves to the result border");
        assert.ok(!sharedLines.includes("Nested calls (2)"));
        assert.ok(!sharedLines.includes("[Script output]"), "full keeps the native parent output");
      } else {
        assert.match(sharedLines, /fixture\(path=one.txt\)/);
        assert.match(sharedLines, /fixture\(path=two.txt\)/);
        assert.match(sharedLines, /2 nested calls/);
        const outputY = rows.findIndex((line) => line.includes("[Script output]"));
        tool.handleMouse({ type: "click", button: "left", x: 14, y: outputY, width: 100, height: rows.length });
        assert.match(tool.render(100).map(stripTerminalSequences).join("\n"), /FINAL ONLY/);
      }
    }
    await commands.get("pretty-tui").handler("clean", commandContext);
    await emit("session_before_compact"); await emit("agent_settled");
    console.log("Native codemode sandbox integration passed.");
  }
}

// Cache notices are derived by Pi, not persisted or treated as extension
// warnings. Historical insertion must target the owning message's group.
{
  const timeline = new ActivityTimeline();
  const first = timeline.addTool("cache-first", "bash");
  const next = timeline.addTool("cache-next", "read");
  timeline.boundary();
  const later = timeline.addTool("cache-later", "bash");
  const notice = timeline.addUpdateAfterMember(first.id, "miss:first", "Cache miss", "", "warning");
  assert.deepEqual(timeline.groupForMember(first.id).members.map((member) => member.id), [first.id, notice.id, next.id]);
  assert.equal(timeline.groupForMember(notice.id), timeline.groupForMember(first.id));
  assert.equal(timeline.currentGroup(), timeline.groupForMember(later.id));
  assert.equal(timeline.addUpdateAfterMember(first.id, "miss:first", "Cache miss", "", "warning"), notice);
  const standalone = timeline.addStandaloneUpdate("miss:answer", "Cache miss", "", "warning");
  assert.ok(!timeline.hasWork(timeline.groupForMember(standalone.id)));
  assert.equal(timeline.currentGroup(), timeline.groupForMember(later.id));
  timeline.discardUpdate("miss:first");
  assert.deepEqual(timeline.groupForMember(first.id).members.map((member) => member.id), [first.id, next.id]);
  assert.ok(!timeline.groupForMember(first.id).hardBoundarySplit);
  timeline.discardUpdate("miss:answer");
  assert.equal(timeline.groupForMember(standalone.id), undefined);
  assert.equal(timeline.currentGroup(), timeline.groupForMember(later.id));
}
if (typeof InteractiveMode.prototype.addCacheMissNotice === "function") {
  const firstMessage = assistant("90", undefined, [{ id: "cache-owner-first", name: "bash" }]);
  const nextMessage = assistant("92", "91", [{ id: "cache-owner-next", name: "read" }]);
  const laterMessage = assistant("95", "94", [{ id: "cache-owner-later", name: "bash" }]);
  const entries = [firstMessage, result("91", "90", "cache-owner-first"), nextMessage,
    result("93", "92", "cache-owner-next"), user("94", "93"), laterMessage,
    result("96", "95", "cache-owner-later")];
  const makeTool = (name, id) => {
    const tool = new ToolExecutionComponent(name, id, {}, undefined,
      { renderShell: "self", renderCall: () => new Text(name, 0, 0) }, { requestRender() {} }, process.cwd());
    tool.updateResult({ content: [{ type: "text", text: "Done" }], isError: false });
    return tool;
  };
  const render = (component) => component.render(120).map(stripTerminalSequences).join("\n");
  const miss = { missedTokens: 79_000, missedCost: 0.15, idleMs: 1000, modelChanged: false };
  await emit("session_start", {}, sessionContext(entries));
  const firstAssistant = new AssistantMessageComponent(firstMessage.message, false);
  const first = makeTool("bash", "cache-owner-first");
  const children = [firstAssistant, first];
  const host = { ui: { requestRender() {} }, chatContainer: { children, addChild(child) { children.push(child); } } };
  InteractiveMode.prototype.addCacheMissNotice.call(host, miss);
  assert.equal(children.length, 3, "native spacer/text were appended instead of one activity projection");
  const notice = children.at(-1);
  assert.equal(render(notice), "", "collapsed group exposed its cache notice");
  first.render(120); first.setExpanded(true);
  assert.match(render(notice), /├─ ⚠ Cache miss: 79k tokens re-billed \(~\$0\.15\)/);
  InteractiveMode.prototype.addCacheMissNotice.call(host, miss);
  assert.equal(children.length, 3, "same assistant cache notice was duplicated");
  const next = makeTool("read", "cache-owner-next");
  const later = makeTool("bash", "cache-owner-later");
  assert.equal(next.render(120).map(stripTerminalSequences).at(-1), "  └─ [↑ Collapse]");
  assert.equal(later.render(120).length, 2, "historical notice altered the last group's visibility");
  const nextRows = next.render(120).map(stripTerminalSequences);
  next.handleMouse({ type: "click", button: "left", x: 7, y: nextRows.length - 1, width: 120, height: nextRows.length });
  assert.equal(render(notice), "");

  const beforeThreshold = children.length;
  InteractiveMode.prototype.addCacheMissNotice.call(host, { ...miss, missedTokens: 100, missedCost: 0.001 });
  assert.equal(children.length, beforeThreshold, "native cache-miss noise threshold changed");
  // A rebuild resets derived nodes; it does not need or append a session entry.
  const savedEntryCount = appendedEntries.length;
  await emit("session_tree", {}, sessionContext(entries));
  const rebuiltFirst = makeTool("bash", "cache-owner-first");
  host.chatContainer.children = [new AssistantMessageComponent(firstMessage.message, false), rebuiltFirst];
  host.chatContainer.addChild = function (child) { this.children.push(child); };
  InteractiveMode.prototype.addCacheMissNotice.call(host, miss);
  const rebuiltNotice = host.chatContainer.children.at(-1);
  rebuiltFirst.render(120); rebuiltFirst.setExpanded(true);
  assert.match(render(rebuiltNotice), /Cache miss: 79k/);
  assert.equal(appendedEntries.length, savedEntryCount);

  // A visible answer with no following tool/thought work gets an independent
  // notice. It must not join the last pre-restored (future) activity group.
  const answer = assistant("97", "96", [], "Final answer");
  await emit("session_start", {}, sessionContext([...entries, answer]));
  host.chatContainer.children = [new AssistantMessageComponent(answer.message, false)];
  InteractiveMode.prototype.addCacheMissNotice.call(host, { ...miss, idleMs: 360_000 });
  assert.match(render(host.chatContainer.children.at(-1)), /⚠ Cache miss after 6m idle/);
  assert.ok(!render(host.chatContainer.children.at(-1)).includes("Collapse"));

  // Live diagnostics can appear immediately before the notice. The actual
  // streaming assistant still owns it; cache warnings do not seal its group.
  await emit("session_start", {}, sessionContext(entries.slice(0, 2)));
  const liveAssistant = new AssistantMessageComponent(firstMessage.message, false);
  const liveTool = makeTool("bash", "cache-owner-first");
  host.chatContainer.children = [liveAssistant, liveTool, new Text("Provider diagnostic", 0, 0)];
  host.streamingComponent = liveAssistant;
  host.streamingMessage = firstMessage.message;
  InteractiveMode.prototype.addCacheMissNotice.call(host, miss);
  const liveNotice = host.chatContainer.children.at(-1);
  liveTool.render(120); liveTool.setExpanded(true);
  assert.match(render(liveNotice), /Cache miss: 79k/);
  assert.equal(liveNotice.render(120).map(stripTerminalSequences).at(-1), "  └─ [↑ Collapse]");
  assert.ok(!render(liveTool).includes("Collapse"), "tool kept an extra collapse tail");
  const liveRows = liveNotice.render(120).map(stripTerminalSequences);
  liveNotice.handleMouse({ type: "click", button: "left", x: 7, y: liveRows.length - 1, width: 120, height: liveRows.length });
  assert.equal(render(liveNotice), "");

  // All modes retain the same cache-warning content and semantic styling.
  const commandContext = { hasUI: true, ui: { notify() {} } };
  for (const mode of ["full", "compact"]) {
    await commands.get("pretty-tui").handler(mode, commandContext);
    assert.match(render(liveNotice), /Cache miss: 79k/);
    assert.ok(render(liveNotice).includes("⚠"));
    host.chatContainer.children = [];
    InteractiveMode.prototype.addCacheMissNotice.call(host, { ...miss, modelChanged: true });
    assert.equal(host.chatContainer.children.length, 1);
    assert.match(host.chatContainer.children.map(render).join("\n"), /Cache miss after model switch/);
    assert.ok(host.chatContainer.children.map(render).join("\n").includes("⚠"));
  }
  await commands.get("pretty-tui").handler("clean", commandContext);
  liveTool.setExpanded(true);
  // Turning off Pi's notice setting rebuilds the chat without cache nodes.
  // Its removed projection must not leave an invisible member/collapse tail.
  const rebuildHost = {
    ui: { requestRender() {} }, pendingTools: new Map(),
    settingsManager: { getShowCacheMissNotices: () => false },
    renderSessionItems: InteractiveMode.prototype.renderSessionItems,
    chatContainer: { children: [], addChild(child) { this.children.push(child); } },
  };
  InteractiveMode.prototype.renderSessionEntries.call(rebuildHost, []);
  assert.equal(liveTool.render(120).map(stripTerminalSequences).at(-1), "  └─ [↑ Collapse]");
  console.log("Native cache-miss activity integration passed.");
}

// Exercise Pi's real rebuild and live-detection entry points, with wrapped
// child components that cannot be recognized by instanceof or private fields.
if (typeof InteractiveMode.prototype.maybeShowCacheMissNotice === "function") {
  const cost = { input: 0.15, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.15 };
  const coldUsage = { input: 79_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 79_000, cost };
  const warmUsage = { ...coldUsage, input: 0, cacheRead: 79_000, cost: { ...cost, input: 0, total: 0 } };
  const decorate = (entry, timestamp, usage) => ({ ...entry, message: {
    ...entry.message, provider: "fixture", model: "fixture", api: "openai-responses", timestamp, usage,
  } });
  const previous = decorate(assistant("100", undefined, [], "Previous answer"), 1000, warmUsage);
  const first = decorate(assistant("101", "100", [{ id: "scoped-cache-first", name: "bash" }]), 2000, coldUsage);
  const second = decorate(assistant("103", "102", [{ id: "scoped-cache-second", name: "read" }]), 3000, coldUsage);
  const later = decorate(assistant("106", "105", [{ id: "scoped-cache-later", name: "bash" }]), 4000, warmUsage);
  const entries = [previous, first, result("102", "101", "scoped-cache-first"), second,
    result("104", "103", "scoped-cache-second"), user("105", "104"), later,
    result("107", "106", "scoped-cache-later")];
  const raw = [];
  const host = {
    ui: { requestRender() {} }, pendingTools: new Map(),
    settingsManager: { getShowCacheMissNotices: () => true, getShowImages: () => false, getImageWidthCells: () => undefined },
    sessionManager: { getEntries: () => entries, getCwd: () => process.cwd() },
    session: { modelRuntime: { getModel: () => ({ cost: { cacheRead: 0 } }) } },
    getMarkdownThemeWithSettings: () => getMarkdownTheme(),
    getMarkdownTransformers: () => undefined,
    getUserMessageText: (message) => message.content.map((item) => item.text ?? "").join("\n"),
    outputPad: undefined,
    hiddenThinkingLabel: undefined,
    maybeShowAssistantDiagnostics: () => {},
    updateFooter: false,
    hideThinkingBlock: false,
    getRegisteredToolDefinition: (name) => ({ renderShell: "self", renderCall: () => new Text(name, 0, 0) }),
    addMessageToChat: InteractiveMode.prototype.addMessageToChat,
    addCacheMissNotice: InteractiveMode.prototype.addCacheMissNotice,
    addCustomEntryToChat: () => {},
    addCompactionCostNotice: () => {},
    updateEditorBorderColor: () => {},
    footer: { invalidate: () => {} },
    renderSessionItems: InteractiveMode.prototype.renderSessionItems,
    chatContainer: { children: [], addChild(component) {
      raw.push(component);
      this.children.push({ render: (width) => component.render(width), invalidate() { component.invalidate?.(); } });
    } },
  };
  await emit("session_start", {}, sessionContext(entries));
  InteractiveMode.prototype.renderSessionEntries.call(host, entries);
  const firstTool = raw.find((component) => component.toolCallId === "scoped-cache-first");
  firstTool.render(120); firstTool.setExpanded(true);
  const text = (component) => component.render(120).map(stripTerminalSequences).join("\n");
  const notices = raw.filter((component) => text(component).includes("Cache miss:"));
  assert.equal(notices.length, 2);
  for (const notice of notices) assert.match(text(notice), /^  ├─ ⚠ Cache miss: 79k/m,
    "wrapped rebuild components caused a standalone cache warning");
  assert.equal(notices.at(-1).render(120).map(stripTerminalSequences).at(-1), "  └─ [↑ Collapse]");
  const laterTool = raw.find((component) => component.toolCallId === "scoped-cache-later");
  assert.equal(laterTool.render(120).length, 2, "cache notice was assigned to the last restored group");

  // Live detection must use its argument, not a stale last-rendered message.
  await emit("session_start", {}, sessionContext(entries.slice(0, 3)));
  raw.length = 0; host.chatContainer.children = [];
  host.sessionManager.getEntries = () => [previous];
  host.addMessageToChat(previous.message);
  const liveTool = new ToolExecutionComponent("bash", "scoped-cache-first", {}, undefined,
    host.getRegisteredToolDefinition("bash"), host.ui, process.cwd());
  liveTool.updateResult({ content: [{ type: "text", text: "Done" }], isError: false });
  host.chatContainer.addChild(liveTool);
  InteractiveMode.prototype.maybeShowCacheMissNotice.call(host, first.message);
  liveTool.render(120); liveTool.setExpanded(true);
  assert.match(text(raw.at(-1)), /^  ├─ ⚠ Cache miss: 79k/m,
    "live cache detection did not bind the actual assistant argument");
  console.log("Wrapped cache-notice rebuild and live entry points passed.");
}

// A live cache miss arrives at message_end, before the message's tools execute.
// It must not float above the tree: it joins the group once its tool appears.
if (typeof InteractiveMode.prototype.maybeShowCacheMissNotice === "function") {
  const cost = { input: 0.15, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.15 };
  const warm = { input: 0, output: 0, cacheRead: 79_000, cacheWrite: 0, totalTokens: 79_000,
    cost: { ...cost, input: 0, total: 0 } };
  const cold = { input: 79_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 79_000, cost };
  const previous = { ...assistant("110", undefined, [], "Previous answer"),
    message: { ...assistant("110", undefined, [], "Previous answer").message,
      provider: "fixture", model: "fixture", timestamp: 1000, usage: warm } };
  const deferredMessage = { ...assistant("112", "111", [{ id: "deferred-cache-tool", name: "bash" }]).message,
    provider: "fixture", model: "fixture", timestamp: 2000, usage: cold };
  await emit("session_start", {}, sessionContext([previous]));
  const children = [];
  const host = {
    ui: { requestRender() {} }, pendingTools: new Map(),
    settingsManager: { getShowCacheMissNotices: () => true },
    sessionManager: { getEntries: () => [previous] },
    session: { modelRuntime: { getModel: () => ({ cost: { cacheRead: 0 } }) } },
    addCacheMissNotice: InteractiveMode.prototype.addCacheMissNotice,
    chatContainer: { children, addChild(component) { children.push(component); } },
  };
  const before = children.length;
  InteractiveMode.prototype.maybeShowCacheMissNotice.call(host, deferredMessage);
  assert.equal(children.length, before, "notice was mounted before its tool existed");

  const tool = new ToolExecutionComponent("bash", "deferred-cache-tool", {}, undefined,
    { renderShell: "self", renderCall: () => new Text("bash", 0, 0) }, host.ui, process.cwd());
  tool.updateResult({ content: [{ type: "text", text: "Done" }], isError: false });
  children.push(tool);
  await emit("tool_execution_start", { toolCallId: "deferred-cache-tool", toolName: "bash" }, sessionContext([previous]));
  const notice = children.at(-1);
  assert.notEqual(notice, tool, "deferred notice was never attached");
  assert.equal(children.length, before + 2);
  tool.setExpanded(true); // a collapsed group hides non-first members
  const toolLines = tool.render(120).map(stripTerminalSequences);
  assert.match(toolLines.join("\n"), /● (?:Running|Done)\(1 tool call/, "group summary disappeared");
  assert.match(notice.render(120).map(stripTerminalSequences).join("\n"), /Cache miss: 79k/);
  assert.equal(notice.render(120).map(stripTerminalSequences)[0], "  ├─ ⚠ Cache miss: 79k tokens re-billed (~$0.15)");
  console.log("Deferred live cache notice joined its tool group.");
}

InteractiveMode.prototype.showStatus.call(
  {
    ui: { requestRender() {} },
    chatContainer: { addChild() {} },
  },
  "Shutdown status",
);
assert.equal(widgets.has("pretty-tui-latest-activity"), true);
await emit("session_shutdown");
assert.equal(widgets.has("pretty-tui-latest-activity"), false, "session_shutdown left the flash installed");
assert.equal(Markdown.prototype.handleMouse, undefined);

// Reload and /pretty-tui disable both rely on session_shutdown putting every
// patched method back. Compare against snapshots taken before the extension was
// loaded instead of merely asserting "something changed", and cover every
// patched method rather than a sample: a partial restore leaves pretty-tui
// active after it reports itself disabled.
for (const [label, target, method, original] of originalPrototypeMethods) {
  assert.equal(target[method], original, `${label} was not restored`);
}
for (const key of [...protoPatchKeys, ...symbolPatchKeys]) {
  assert.equal(key.owner[key.symbol], undefined, `${key.label} patch key survived`);
}
assert.notEqual(Markdown.prototype.renderToken, patchedMarkdownRenderToken);
assert.notEqual(AssistantMessageComponent.prototype.render, patchedAssistantRender);
assert.notEqual(AssistantMessageComponent.prototype.handleMouse, patchedAssistantMouse);
assert.notEqual(CustomMessageComponent.prototype.render, patchedCustomMessageRender);
assert.notEqual(ToolExecutionComponent.prototype.render, patchedToolRender);
assert.notEqual(InteractiveMode.prototype.showExtensionNotify, patchedShowExtensionNotify);
assert.notEqual(TuiAltScreen.prototype.handleSelectionMouseEvent, patchedSelectionHandler);

// Disabled startup keeps only the settings command: no tools, event handlers,
// or prototype patches are installed. The command can persist re-enabling.
{
  const disabledAgentDir = mkdtempSync(join(tmpdir(), "pi-pretty-tui-disabled-test-"));
  writeFileSync(join(disabledAgentDir, "pretty-tui.json"), '{"enabled":false,"mode":"clean"}\n');
  process.env.PI_CODING_AGENT_DIR = disabledAgentDir;
  const disabledCommands = new Map();
  const disabledHandlers = [];
  const disabledTools = [];
  extension({
    appendEntry() {},
    on(name) { disabledHandlers.push(name); },
    registerCommand(name, command) { disabledCommands.set(name, command); },
    registerEntryRenderer() {},
    registerTool(tool) { disabledTools.push(tool.name); },
    registerToolRenderer() { disabledTools.push("renderer"); },
  });
  assert.deepEqual(disabledHandlers, []);
  assert.deepEqual(disabledTools, []);
  assert.ok(disabledCommands.has("pretty-tui"));
  const notices = [];
  let reloads = 0;
  await disabledCommands.get("pretty-tui").handler("enable", {
    hasUI: true,
    ui: { notify(message, type) { notices.push([message, type]); } },
    async reload() { reloads += 1; },
  });
  assert.equal(JSON.parse(readFileSync(join(disabledAgentDir, "pretty-tui.json"), "utf8")).enabled, true);
  assert.equal(reloads, 1);
  assert.ok(notices.at(-1)[0].includes("reloading"));
  rmSync(disabledAgentDir, { recursive: true, force: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
}

rmSync(agentDir, { recursive: true, force: true });
console.log("Regression suite passed.");

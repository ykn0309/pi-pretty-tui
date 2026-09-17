import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import {
  ActivityTimeline,
  assistantSystemBoundary,
} from "../extensions/activity-timeline.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-pretty-tui-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
initTheme("dark", false);

const jiti = createJiti(import.meta.url);
const extension = await jiti.import(join(process.cwd(), "extensions/index.ts"), { default: true });
const handlers = new Map();
const tools = new Map();
const appendedEntries = [];
const pi = {
  appendEntry(type, data) { appendedEntries.push({ type, data }); },
  on(name, handler) {
    const eventHandlers = handlers.get(name) ?? [];
    eventHandlers.push(handler);
    handlers.set(name, eventHandlers);
  },
  registerCommand() {},
  registerEntryRenderer() {},
  registerTool(tool) { tools.set(tool.name, tool); },
};
extension(pi);

const theme = {
  bold: (text) => text,
  fg: (_name, text) => text,
};
const emit = async (name, event = {}, ctx = {}) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
const sessionContext = (entries) => ({
  sessionManager: { buildContextEntries: () => entries },
  ui: {
    getToolsExpanded: () => false,
    notify() {},
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

// The transcript-first model keeps thinking and all tools in order while
// system errors create hard boundaries.
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
  assert.equal(assistantSystemBoundary({ role: "assistant", stopReason: "error", content: [] }), true);
  assert.equal(assistantSystemBoundary({ role: "assistant", stopReason: "toolUse", content: [] }), false);
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

// Assistant/system errors are hard boundaries and remain outside activity groups.
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
}

// Info notifications without a valid activity group fail open to Pi's native
// notification path instead of being dropped.
{
  await emit("session_start", {}, sessionContext([]));
  const nativeInfo = [];
  InteractiveMode.prototype.showExtensionNotify.call({
    showStatus(message) { nativeInfo.push(message); },
  }, "Standalone info", "info");
  assert.deepEqual(nativeInfo, ["Standalone info"]);
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
  firstComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: firstComponent.render(80).length,
  });
  const compactMixed = mixedComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(compactMixed.includes("● Thought"));
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

// Persisted custom_message entries restore as ordered activity updates instead
// of falling back to Pi's purple CustomMessage box.
{
  const call = assistant("40", null, [{ id: "restored-custom-tool", name: "obs_recall" }]);
  const customEntry = {
    type: "custom_message",
    id: "42",
    parentId: "41",
    timestamp: "2026-01-01T00:01:12.000Z",
    customType: "web-search-content-ready",
    content: "Content fetched for 1/2 URLs",
    display: true,
  };
  const restoredEntries = [
    call,
    result("41", "40", "restored-custom-tool"),
    customEntry,
  ];
  await emit("session_start", {}, sessionContext(restoredEntries.slice(0, 2)));
  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "fullscreen" } }, restoredEntries);
  } catch {}
  const restoredTool = new ToolExecutionComponent(
    "obs_recall",
    "restored-custom-tool",
    {},
    undefined,
    { renderShell: "self", renderCall: () => new Text("recall", 0, 0) },
    { requestRender() {} },
    process.cwd(),
  );
  const restoredCustomMessage = {
    role: "custom",
    timestamp: customEntry.timestamp,
    customType: customEntry.customType,
    content: customEntry.content,
    display: true,
  };
  const restoredCustom = new CustomMessageComponent(restoredCustomMessage);
  assert.equal(restoredCustom.render(80).length, 0);
  const restoredParent = restoredTool.render(80);
  restoredTool.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: restoredParent.length,
  });
  const restoredCustomText = restoredCustom.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(restoredCustomText.includes("Web Search Content Ready"));
  assert.ok(restoredCustomText.includes("Content fetched for 1/2 URLs"));
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
  assert.deepEqual(nativeNotifications, [
    ["warning", "Keep warning native"],
    ["error", "Keep error native"],
  ]);
  assert.equal(infoComponents.length, 2);
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
  assert.ok(collapsedThinkingText.includes("Running("));
  assert.ok(collapsedThinkingText.includes("1 thought"));
  assert.ok(!collapsedThinkingText.includes("Footer info"));
  assert.equal(collapsedTool.length, 0);
  assert.equal(infoComponents[0].render(80).length, 0);
  assert.equal(customComponent.render(80).length, 0);
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
  assert.ok(compactThinkingText.includes("├─") && compactThinkingText.includes("● Thought"));
  assert.ok(!compactThinking.includes("Inspect compatibility"));
  const compactToolText = compactTool.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const infoUpdateText = infoUpdate.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.ok(compactToolText.includes("├─") && compactToolText.includes("● Recall Observation"));
  assert.ok(compactToolText.includes("ok"));
  assert.ok(infoUpdateText.includes("◇ Footer info"));
  assert.ok(customUpdate.includes("└─") && customUpdate.includes("Web Search Content Ready"));
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
  assert.ok(fullThinkingText.includes("● Thought"));
  assert.ok(fullThinking.includes("│") && fullThinking.includes("Preserve native rendering"));
  assert.ok(fullThinking.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("└ Preserve native rendering"));
  assert.ok(!fullThinking.includes("Thinking..."));
  thinkingComponent.handleMouse({
    type: "click", button: "left", x: 8, y: 2, width: 80, height: thinkingComponent.render(80).length,
  });
  const reCollapsedThinking = thinkingComponent.render(80).join("\n");
  assert.ok(reCollapsedThinking.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("● Thought"));
  assert.ok(!reCollapsedThinking.includes("Preserve native rendering"));
  thinkingComponent.handleMouse({
    type: "click", button: "left", x: 1, y: 1, width: 80, height: thinkingComponent.render(80).length,
  });
  const reCollapsedParent = thinkingComponent.render(80).join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.match(reCollapsedParent, /(?:Running|Done)\(/);
  assert.ok(!reCollapsedParent.includes("● Thought"));
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

  const headingCases = [
    ["# One", ["╔═════╗", "║ One ║", "╚═════╝"]],
    ["## Two", ["Two"]],
    ["### Three", ["Three"]],
    ["#### Four", ["Four"]],
    ["##### Five", ["┄┄ Five ┄┄"]],
    ["###### Six", ["Six"]],
  ];
  for (const [source, expected] of headingCases) {
    const rendered = new Markdown(source, 0, 0, markdownTheme).render(20);
    const unstyled = rendered.map((line) =>
      line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd(),
    );
    assert.deepEqual(unstyled, expected);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 20));
  }
  const primaryHeading = new Markdown("# Primary", 0, 0, markdownTheme).render(20);
  const secondaryHeading = new Markdown("## Secondary", 0, 0, markdownTheme).render(20);
  assert.ok(primaryHeading.every((line) => !line.includes("\x1b[7m")));
  assert.ok(primaryHeading[1].includes("\x1b[4m"));
  assert.ok(secondaryHeading[0].includes("\x1b[48;5;94m"));
  assert.ok(secondaryHeading[0].includes("\x1b[97m") && secondaryHeading[0].includes("\x1b[4m"));
  assert.ok(!secondaryHeading[0].includes("\x1b[7m"));
  const lightMarkdownTheme = {
    ...markdownTheme,
    heading: (text) => `\x1b[38;2;154;115;38m${text}\x1b[39m`,
  };
  const lightSecondaryHeading = new Markdown(
    "## Light",
    0,
    0,
    lightMarkdownTheme,
    { color: (text) => `\x1b[38;2;31;35;40m${text}\x1b[39m` },
  ).render(20);
  assert.ok(lightSecondaryHeading[0].includes("\x1b[107m"));
  assert.ok(lightSecondaryHeading[0].includes("\x1b[7m"));
  assert.ok(!lightSecondaryHeading[0].includes("\x1b[48;5;94m"));
  const sixthHeading = new Markdown("###### Readable", 0, 0, markdownTheme).render(20);
  assert.ok(sixthHeading[0].includes("\x1b[3m") && sixthHeading[0].includes("\x1b[90m"));
  const narrowHeading = new Markdown("# Narrow heading", 0, 0, markdownTheme).render(5);
  assert.ok(narrowHeading.every((line) => visibleWidth(line) <= 5));

  const markdown = new Markdown("```ts\nconst a = 1;\n```\n\n~~~json\n{\"ok\":true}\n~~~", 2, 1, markdownTheme);
  const lines = markdown.render(42);
  const plain = lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  const headers = plain.map((line, y) => ({ line, y })).filter(({ line }) => line.includes("[Copy]"));
  assert.equal(headers.length, 2);
  assert.ok(headers.every(({ line }) => line.trimStart().startsWith("╭─")));
  assert.ok(plain.some((line) => line.includes("│ const a = 1;")));
  assert.ok(plain.some((line) => line.trimStart().startsWith("╰─")));
  for (const { line, y } of headers) {
    const x = line.indexOf("[Copy]") + 1;
    assert.equal(markdown.handleMouse({ type: "press", button: "left", x, y, width: 42, height: lines.length })?.handled, true);
  }
  const firstCopyX = headers[0].line.indexOf("[Copy]") + 1;
  assert.equal(markdown.handleMouse({
    type: "click",
    button: "left",
    x: firstCopyX,
    y: headers[0].y,
    width: 42,
    height: lines.length,
  })?.handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(nativeCopies, ["const a = 1;"]);

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
  assert.deepEqual(nativeCopies, ["const a = 1;", "echo mixed response"]);

  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
  for (const width of [1, 4, 7, 8, 17, 18, 24]) {
    const narrow = new Markdown("```sh\necho 12345678901234567890\n```", 0, 0, markdownTheme).render(width);
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    const hasCopy = narrow.some((line) =>
      line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("[Copy]"),
    );
    assert.equal(hasCopy, width >= 18);
  }
  markdown.setText("updated");
  const staleX = headers[0].line.indexOf("[Copy]") + 1;
  assert.equal(markdown.handleMouse({ type: "press", button: "left", x: staleX, y: headers[0].y, width: 42, height: lines.length })?.handled, undefined);

  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "regular" } }, []);
  } catch {}
  const regular = new Markdown("```sh\necho regular\n```", 0, 0, markdownTheme).render(30);
  assert.ok(regular.every((line) => !line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("[Copy]")));
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
await emit("session_shutdown");
assert.equal(Markdown.prototype.handleMouse, undefined);
assert.notEqual(Markdown.prototype.renderToken, patchedMarkdownRenderToken);
assert.notEqual(AssistantMessageComponent.prototype.render, patchedAssistantRender);
assert.notEqual(AssistantMessageComponent.prototype.handleMouse, patchedAssistantMouse);
assert.notEqual(CustomMessageComponent.prototype.render, patchedCustomMessageRender);
assert.notEqual(ToolExecutionComponent.prototype.render, patchedToolRender);
assert.notEqual(InteractiveMode.prototype.showExtensionNotify, patchedShowExtensionNotify);
assert.notEqual(TuiAltScreen.prototype.handleSelectionMouseEvent, patchedSelectionHandler);
rmSync(agentDir, { recursive: true, force: true });
console.log("Regression suite passed.");

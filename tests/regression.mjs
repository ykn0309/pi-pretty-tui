import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { Markdown, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "pi-pretty-tui-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

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
  await emit("session_compact");
  await runTool("live-after-compact");
  await emit("agent_settled");
  assert.deepEqual(
    appendedEntries.at(-1).data.groups.map((group) => group.lastToolCallId),
    ["live-before-steer", "live-before-compact", "live-after-compact"],
  );
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
    heading: (text) => `\x1b[33m${text}\x1b[39m`,
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
await emit("session_shutdown");
assert.equal(Markdown.prototype.handleMouse, undefined);
assert.notEqual(Markdown.prototype.renderToken, patchedMarkdownRenderToken);
assert.notEqual(TuiAltScreen.prototype.handleSelectionMouseEvent, patchedSelectionHandler);
rmSync(agentDir, { recursive: true, force: true });
console.log("Regression suite passed.");

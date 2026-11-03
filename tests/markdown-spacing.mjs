// Markdown list spacing: pure policy tests, then integration through Pi's real
// transcript and Markdown components. Pi with no extension is the oracle: spacing
// may only change blank rows, so every other row must keep its text and style.
//
// To test against another Pi, set PI_HOST_MODULE and PI_TUI_MODULE to the dist/index.js
// of its pi-coding-agent and pi-tui packages.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// Set before Pi loads: chalk reads it once, and drops all styling off a TTY without it.
process.env.FORCE_COLOR = "3";
const agentDir = mkdtempSync(join(tmpdir(), "pi-pretty-tui-spacing-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const hostPath = process.env.PI_HOST_MODULE && resolve(process.env.PI_HOST_MODULE);
const tuiPath = process.env.PI_TUI_MODULE && resolve(process.env.PI_TUI_MODULE);
assert.equal(Boolean(hostPath), Boolean(tuiPath), "set PI_HOST_MODULE and PI_TUI_MODULE together");
const agent = await import(hostPath ? pathToFileURL(hostPath).href : "@earendil-works/pi-coding-agent");
const tui = await import(tuiPath ? pathToFileURL(tuiPath).href : "@earendil-works/pi-tui");
const { AssistantMessageComponent, InteractiveMode, getMarkdownTheme, initTheme } = agent;
const { Markdown, stripTerminalSequences, visibleWidth } = tui;
const jiti = createJiti(import.meta.url, hostPath
  ? { alias: { "@earendil-works/pi-coding-agent": hostPath, "@earendil-works/pi-tui": tuiPath } }
  : {});
const { MARKDOWN_GAP_ROWS, gapRowsAfterBlock, renderSpacedList } = await jiti.import(
  join(process.cwd(), "extensions/markdown-spacing.ts"),
);

const THEMES = ["dark", "light"];
const MODES = ["clean", "compact", "full"];
const WIDTHS = [24, 40, 60, 90, 120];
const LONG = "This is an explanatory list item with enough words to wrap onto multiple lines even in a fairly wide terminal window.";
const REPLACE_ME = "\0";

// `added` is the row count relative to Pi with no extension. It must not depend on
// width, mode or theme. `golden` is the plain clean-mode render at width 90.
const FIXTURES = {
  short: { src: "- Alpha\n- Beta\n- Gamma", added: 2, golden: ["• Alpha", "", "• Beta", "", "• Gamma"] },
  shortOrdered: { src: "1. One\n2. Two\n3. Three", added: 2, golden: ["1. One", "", "2. Two", "", "3. Three"] },
  orderedStart: { src: "9. Nine\n10. Ten", added: 1, golden: ["9. Nine", "", "10. Ten"] },
  wrapped: { src: `- ${LONG}\n- ${LONG}`, added: 1 },
  orderedWrapped: { src: `9. ${LONG}\n10. ${LONG}`, added: 1 },
  mixedLength: { src: `- ${LONG}\n- Short\n- Tiny`, added: 2 },
  boldLeads: {
    src: "Two fixes:\n- **Simple:** set a `flag`\n- **Precise:** one *row*",
    added: 2,
    golden: ["Two fixes:", "", "• Simple: set a flag", "", "• Precise: one row"],
  },
  introNoBlank: { src: "Intro\n- A\n- B", added: 2, golden: ["Intro", "", "• A", "", "• B"] },
  introSourceBlank: { src: "Intro\n\n- A\n- B\n\nOutro", added: 1, golden: ["Intro", "", "• A", "", "• B", "", "Outro"] },
  nested: {
    src: "- Parent\n  - Child one\n  - Child two\n    1. Deep\n- Tail",
    added: 4,
    golden: ["• Parent", "", "• Child one", "", "• Child two", "", "1. Deep", "", "• Tail"],
  },
  nestedWrapped: { src: `- ${LONG}\n  - ${LONG}\n  - Child\n- Tail`, added: 3 },
  task: { src: "- [ ] Open\n- [x] Done", added: 1, golden: ["• [ ] Open", "", "• [x] Done"] },
  taskWrapped: { src: `- [ ] ${LONG}\n- [x] Done`, added: 1 },
  taskNested: { src: "- [ ] Open\n  - [x] Sub\n- [ ] Tail", added: 2, golden: ["• [ ] Open", "", "• [x] Sub", "", "• [ ] Tail"] },
  loose: { src: "- One\n\n- Two\n\n- Three", added: 0, golden: ["• One", "", "• Two", "", "• Three"] },
  looseParagraphs: { src: "- One\n\n  Second para\n\n- Two", added: 0, golden: ["• One", "", "Second para", "", "• Two"] },
  looseTask: { src: "- [ ] One\n\n- [x] Two", added: 0, golden: ["• [ ] One", "", "• [x] Two"] },
  // Pi alone doubles this gap: a trailing space token plus its loose-list row. The policy keeps one.
  looseExtraBlanks: { src: "- One\n\n\n- Two\n\nAfter", added: -1, golden: ["• One", "", "• Two", "", "After"] },
  complexQuote: { src: "- Text\n  > quoted\n- Tail", added: 2 },
  itemListThenParagraph: { src: "- A\n  - b\n\n  c\n- D", added: 1, golden: ["• A", "", "• b", "", "c", "", "• D"] },
  tableThenList: { src: "| a |\n|---|\n| b |\n- x\n- y", added: 1 },
  quoted: { src: "> Intro\n> - A\n> - B", added: 2, golden: ["│ Intro", "│", "│ • A", "│", "│ • B"] },
  quoteThenList: { src: "> q\n- A\n- B", added: 1 },
  listThenQuote: { src: "- A\n> q", added: 1, golden: ["• A", "", "│ q"] },
  cjk: { src: `说明\n- ${"中文段落和表情 🧪 ".repeat(15)}\n- 简短`, added: 2 },
  emptyTask: { src: "- [ ]\n- [x] Done", added: 1 },
  emptyItems: { src: "-\n- b\n-", added: 2 },
  taskParagraph: { src: "- [ ] Open\n\n  more\n- [x] Done", added: 0 },
  itemDefinition: { src: "- a\n\n  [x]: https://example.com\n- b", added: -1 },
  noListProse: { src: "**Bold lead.** Paragraph with `code` and *italic*.\n\nSecond paragraph.", added: 0, golden: ["Bold lead. Paragraph with code and italic.", "", "Second paragraph."] },
};
// The extension restyles headings, code blocks and rules on purpose, so these have no native oracle.
const RESTYLED_FIXTURES = {
  headingThenList: { src: "#### H\n- A\n- B", golden: ["H", "", "• A", "", "• B"] },
  listThenHeading: { src: "- A\n- B\n#### Next", golden: ["• A", "", "• B", "", "Next"] },
  headingSourceBlank: { src: "- A\n\n#### Next\n\n- B", golden: ["• A", "", "Next", "", "• B"] },
  noListHeading: { src: "### Heading\n\nParagraph.", golden: ["Heading", "", "Paragraph."] },
  complexCode: { src: "- Text\n  ```sh\n  ls\n  ```\n  after\n- Tail" },
  listThenCode: { src: "- A\n```\nx\n```" },
  codeThenList: { src: "```\nx\n```\n- A\n- B" },
  listThenRule: { src: "- A\n---" },
  ruleThenList: { src: "---\n- A\n- B" },
};

const blankRows = (rows) => rows.filter((row) => stripTerminalSequences(row).trim() === "").length;

// Fake renderer for the pure tests: one marker row, then one row per item token.
const fakeRenderList = (singleItemList) => [
  `item-${singleItemList.start}`,
  ...singleItemList.items[0].tokens.map((token) => (token.type === "space" ? "" : `  ${token.type}`)),
];

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const textItem = (...types) => ({ tokens: types.map((type) => ({ type, text: type === "empty" ? "" : "x" })) });

function testGapPolicy() {
  assert.deepEqual(MARKDOWN_GAP_ROWS, { beforeList: 1, afterList: 1, betweenItems: 1, withinItem: 1 });
  assert.deepEqual(gapRowsAfterBlock("paragraph", "list"), [""], "paragraph directly before a list");
  assert.deepEqual(gapRowsAfterBlock("paragraph", "space"), [], "source blank line already separates them");
  assert.deepEqual(gapRowsAfterBlock("paragraph", "code"), [], "Pi spaces other paragraph boundaries");
  assert.deepEqual(gapRowsAfterBlock("paragraph", undefined), []);
  for (const next of ["heading", "paragraph", "code", "hr", "table", "blockquote"]) {
    assert.deepEqual(gapRowsAfterBlock("list", next), [""], `list directly before ${next}`);
  }
  assert.deepEqual(gapRowsAfterBlock("list", "space"), [], "no doubled gap when the source has a blank line");
  assert.deepEqual(gapRowsAfterBlock("list", undefined), [], "no trailing row after the last block");
  assert.deepEqual(gapRowsAfterBlock("heading", "list"), [], "headings keep their own spacing");
  assert.deepEqual(gapRowsAfterBlock(undefined, undefined), []);
}

function testRenderSpacedListOneItemAtATime() {
  const seen = [];
  const list = deepFreeze({
    type: "list", loose: true, ordered: true, start: 9, items: [textItem("text"), textItem("text"), textItem("text")],
  });
  const rows = renderSpacedList(list, (single) => {
    seen.push(single);
    return fakeRenderList(single);
  });
  assert.deepEqual(rows, ["item-9", "  text", "", "item-10", "  text", "", "item-11", "  text"]);
  assert.deepEqual(seen.map((single) => [single.start, single.loose, single.items.length, single.ordered]), [
    [9, false, 1, true], [10, false, 1, true], [11, false, 1, true],
  ], "each item keeps its number, and Pi's loose gap cannot add to the policy gap");
  assert.equal(list.loose, true, "frozen source token is untouched");
  assert.equal(list.items[0].tokens.length, 1, "frozen item tokens are untouched");
  assert.deepEqual(
    renderSpacedList({ type: "list", loose: false, start: "", items: [textItem("text"), textItem("text")] }, fakeRenderList)
      .filter((row) => row.startsWith("item-")),
    ["item-1", "item-2"],
    "an unordered list's empty start counts from one",
  );
  assert.deepEqual(renderSpacedList({ type: "list", loose: false, items: [] }, fakeRenderList), []);
}

function testItemBlockGaps() {
  const tokensOf = (...tokens) => {
    const rendered = [];
    renderSpacedList({ type: "list", loose: false, items: [{ tokens }] }, (single) => {
      rendered.push(...single.items[0].tokens.map((token) => token.type));
      return [];
    });
    return rendered;
  };
  assert.deepEqual(tokensOf({ type: "text", text: "a" }, { type: "list", items: [] }), ["text", "space", "list"]);
  assert.deepEqual(tokensOf({ type: "text", text: "a" }, { type: "code", text: "x" }), ["text", "space", "code"]);
  assert.deepEqual(
    tokensOf({ type: "text", text: "a" }, { type: "space" }, { type: "list", items: [] }),
    ["text", "space", "list"],
    "an existing blank row is not doubled",
  );
  assert.deepEqual(
    tokensOf({ type: "checkbox" }, { type: "text", text: "a" }),
    ["checkbox", "text"],
    "a checkbox is part of the marker, so it must not part the marker from its text",
  );
  assert.deepEqual(
    tokensOf({ type: "def" }, { type: "text", text: "a" }),
    ["def", "text"],
    "a link definition draws nothing",
  );
  assert.deepEqual(tokensOf({ type: "text", text: "a" }, { type: "space" }), ["text"], "no item ends blank");
  assert.deepEqual(tokensOf({ type: "text", text: "a" }, { type: "text", text: "  " }), ["text"], "blank text is a blank row");
  assert.deepEqual(tokensOf({ type: "text", text: "a" }, { type: "html", raw: "\n" }), ["text"], "blank html is a blank row");
  assert.deepEqual(tokensOf({ type: "checkbox" }), [], "an empty task keeps only its marker");
}

function testItemJoinNeverDoubles() {
  const join = (...itemRows) => {
    const queue = [...itemRows];
    return renderSpacedList(
      { type: "list", loose: false, items: itemRows.map(() => ({ tokens: [] })) },
      () => queue.shift(),
    );
  };
  assert.deepEqual(join(["a"], ["b"]), ["a", "", "b"]);
  assert.deepEqual(join(["a", ""], ["b"]), ["a", "", "b"], "item already ends blank");
  assert.deepEqual(join(["a"], ["", "b"]), ["a", "", "b"], "item already starts blank");
  assert.deepEqual(join(["a", "\x1b[0m  \x1b[0m"], ["b"]), ["a", "\x1b[0m  \x1b[0m", "b"], "a styled row of spaces is still blank");
  assert.deepEqual(join(["a"], [], ["b"]), ["a", "", "b"], "an item with no rows adds no gap of its own");
  assert.deepEqual(join([], ["b"]), ["b"], "no gap before the first row");
}

const plain = (row) => stripTerminalSequences(row);
const content = (row) => plain(row).replace(/│/g, "").trim();
const isFrameEdge = (row) => /^\s*[╭╰]/.test(plain(row));
const isBlank = (row) => !isFrameEdge(row) && content(row) === "";

// Drops card borders and outer padding, so all modes are judged by their content.
function innerRows(rows) {
  let first = 0;
  let last = rows.length - 1;
  while (first <= last && (isFrameEdge(rows[first]) || isBlank(rows[first]))) first += 1;
  while (last >= first && (isFrameEdge(rows[last]) || isBlank(rows[last]))) last -= 1;
  return rows.slice(first, last + 1);
}

let messageStamp = 100_000;
const assistantMessage = (text) => ({
  role: "assistant", timestamp: messageStamp, stopReason: "stop", content: [{ type: "text", text }],
});

function newAssistant(text) {
  messageStamp += 1;
  return new AssistantMessageComponent(assistantMessage(text));
}

const renderAssistant = (text, width) => newAssistant(text).render(width);
const markdownOf = (component) => component.contentContainer.children.find((child) => child instanceof Markdown);

const SGR = /^\x1b\[([\d;:]*)m/;
const OTHER_SEQUENCE = /^\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/;
const DEFAULT_STYLE = { bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false, fg: null, bg: null };
const STYLE_ON = { 1: "bold", 2: "dim", 3: "italic", 4: "underline", 7: "inverse", 9: "strike" };
const STYLE_OFF = { 22: ["bold", "dim"], 23: ["italic"], 24: ["underline"], 27: ["inverse"], 29: ["strike"] };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function applySgr(style, sequence) {
  const params = sequence === "" ? [0] : sequence.split(";").map(Number);
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 0) Object.assign(style, DEFAULT_STYLE);
    else if (STYLE_ON[code]) style[STYLE_ON[code]] = true;
    else if (STYLE_OFF[code]) for (const key of STYLE_OFF[code]) style[key] = false;
    else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
    else if (code === 38 || code === 48) {
      const length = params[index + 1] === 2 ? 5 : 3;
      style[code === 38 ? "fg" : "bg"] = params.slice(index, index + length).join(";");
      index += length - 1;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.fg = String(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) style.bg = String(code);
  }
}

// One entry per grapheme with its effective style, so equal output with different escape bytes compares equal.
function styledCells(row) {
  const cells = [];
  const style = { ...DEFAULT_STYLE };
  let offset = 0;
  while (offset < row.length) {
    const rest = row.slice(offset);
    const sgr = SGR.exec(rest);
    if (sgr) {
      applySgr(style, sgr[1]);
      offset += sgr[0].length;
      continue;
    }
    const other = OTHER_SEQUENCE.exec(rest);
    if (other) {
      offset += other[0].length;
      continue;
    }
    const nextEscape = rest.search(/\x1b/);
    const text = nextEscape < 0 ? rest : rest.slice(0, nextEscape || 1);
    for (const { segment } of segmenter.segment(text)) cells.push({ grapheme: segment, ...style });
    offset += text.length;
  }
  return cells;
}

const bulletOpen = () => getMarkdownTheme().listBullet(REPLACE_ME).split(REPLACE_ME)[0];
const withPrettyBullets = (row) => row.replaceAll(`${bulletOpen()}- `, `${bulletOpen()}• `);
const nonblankRows = (rows) => rows.filter((row) => content(row) !== "");
const overlayRows = (src, width) => new Markdown(src, 0, 0, getMarkdownTheme()).render(width);
const allFixtures = () => [...Object.entries(FIXTURES), ...Object.entries(RESTYLED_FIXTURES)];

function captureNative() {
  const assistant = {};
  const overlay = {};
  for (const theme of THEMES) {
    initTheme(theme, false);
    for (const width of WIDTHS) {
      for (const [name, fixture] of Object.entries(FIXTURES)) {
        assistant[`${theme}/${width}/${name}`] = renderAssistant(fixture.src, width);
      }
    }
    for (const [name, fixture] of allFixtures()) overlay[`${theme}/${name}`] = overlayRows(fixture.src, 50);
  }
  return { assistant, overlay };
}

async function loadExtension() {
  const handlers = new Map();
  const commands = new Map();
  const extension = await jiti.import(join(process.cwd(), "extensions/index.ts"), { default: true });
  extension({
    appendEntry() {},
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name, command) { commands.set(name, command); },
    registerEntryRenderer() {},
    registerTool() {},
    registerToolRenderer() {},
    getAllTools() { return []; },
  });
  const ctx = { hasUI: true, ui: { notify() {} } };
  return {
    setMode: (mode) => commands.get("pretty-tui").handler(mode, ctx),
    shutdown: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

function assertNoDoubledGap(rows, label) {
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(!(isBlank(rows[index]) && isBlank(rows[index - 1])), `${label}: doubled gap at row ${index}`);
  }
}

// Narrow widths can make Pi hard-wrap indentation into its own whitespace rows, which are not policy gaps.
const hasNativeWhitespaceRows = (nativeRows, fixture) => !fixture.src.includes("\n\n") && innerRows(nativeRows).some(isBlank);

async function testEveryFixtureInEveryMode(extension, native) {
  for (const theme of THEMES) {
    initTheme(theme, false);
    for (const mode of MODES) {
      await extension.setMode(mode);
      for (const width of WIDTHS) {
        for (const [name, fixture] of Object.entries(FIXTURES)) {
          const label = `${theme}/${mode}/${width}/${name}`;
          const nativeRows = native.assistant[`${theme}/${width}/${name}`];
          const rows = renderAssistant(fixture.src, width);
          assert.ok(rows.every((row) => visibleWidth(row) <= width), `${label}: fits width`);
          const inner = innerRows(rows);
          if (!hasNativeWhitespaceRows(nativeRows, fixture)) assertNoDoubledGap(inner, label);
          if (mode !== "clean") continue;
          assert.equal(rows.length - nativeRows.length, fixture.added, `${label}: blank-row delta`);
          assert.deepEqual(
            nonblankRows(rows).map(styledCells),
            nonblankRows(nativeRows).map((row) => styledCells(withPrettyBullets(row))),
            `${label}: text, wrapping, bold, italic and code cells match Pi`,
          );
        }
        for (const [name, fixture] of Object.entries(RESTYLED_FIXTURES)) {
          const label = `${theme}/${mode}/${width}/${name}`;
          const rows = renderAssistant(fixture.src, width);
          assert.ok(rows.every((row) => visibleWidth(row) <= width), `${label}: fits width`);
          assertNoDoubledGap(innerRows(rows), label);
        }
      }
    }
  }
  await extension.setMode("clean");
  initTheme("dark", false);
}

function testGoldens() {
  for (const [name, fixture] of allFixtures()) {
    if (!fixture.golden) continue;
    const rows = innerRows(renderAssistant(fixture.src, 90)).map((row) => plain(row).trim());
    assert.deepEqual(rows, fixture.golden, `${name}: golden rows`);
  }
  const nested = innerRows(renderAssistant(FIXTURES.nested.src, 90)).map((row) => plain(row).trimEnd()).filter(Boolean);
  assert.deepEqual(nested.map((row) => row.match(/^ */)[0].length), [1, 5, 5, 9, 1], "nesting indentation is Pi's");
}

const spanCells = (rows, text) => {
  const ink = rows.flatMap(styledCells).filter((cell) => cell.grapheme.trim() !== "");
  const needle = [...segmenter.segment(text.replace(/\s+/g, ""))].map((entry) => entry.segment);
  const start = ink.findIndex((_, offset) => needle.every((grapheme, index) => ink[offset + index]?.grapheme === grapheme));
  assert.ok(start >= 0, `"${text}" rendered`);
  return ink.slice(start, start + needle.length);
};

function testInlineStylesKept() {
  const rows = renderAssistant("Intro\n- **Bold lead:** plain `code` and *italic* end\n- **Second `inner`** tail", 90);
  assert.ok(spanCells(rows, "Bold lead:").every((cell) => cell.bold && !cell.underline), "bold stays bold, not a heading");
  assert.ok(spanCells(rows, "plain").every((cell) => !cell.bold), "bold does not leak past its span");
  assert.ok(spanCells(rows, "code").every((cell) => cell.fg !== null), "inline code keeps its color");
  assert.ok(spanCells(rows, "italic").every((cell) => cell.italic && !cell.bold), "italic stays italic");
  assert.ok(spanCells(rows, "inner").every((cell) => cell.bold && cell.fg !== null), "code inside bold keeps both");
}

function testOverlaysUntouched(native) {
  for (const theme of THEMES) {
    initTheme(theme, false);
    for (const [name, fixture] of allFixtures()) {
      assert.deepEqual(
        overlayRows(fixture.src, 50),
        native.overlay[`${theme}/${name}`].map(withPrettyBullets),
        `${theme}/${name}: Markdown outside the transcript stays native apart from the bullet`,
      );
    }
  }
  initTheme("dark", false);
}

function testCachedTokensAndRerenders() {
  const source = `${FIXTURES.nested.src}\n\n- Text\n  > quote\n  - nested\n- Tail`;
  const component = newAssistant(source);
  const first = [...component.render(90)];
  const markdown = markdownOf(component);
  const tokensBefore = JSON.stringify(markdown.cachedTokens.deref().tokens);
  const bullet = markdown.theme.listBullet;

  const narrow = component.render(60);
  assert.ok(narrow.every((row) => visibleWidth(row) <= 60), "resize fits");
  markdown.invalidate();
  assert.deepEqual([...component.render(90)], first, "resize and invalidate add no gaps");
  assert.equal(JSON.stringify(markdown.cachedTokens.deref().tokens), tokensBefore, "cached parsed tokens are not mutated");
  assert.equal(markdown.text, source, "component source text is not changed");
  assert.equal(markdown.theme.listBullet, bullet, "theme listBullet is restored");
  const cached = markdown.render(markdown.cachedWidth);
  assert.equal(markdown.render(markdown.cachedWidth), cached, "unchanged Markdown returns its cached rows");
}

function testPreservedOrderedMarkers() {
  const component = newAssistant("7) seven\n3) three\n   + plus\n   * star\n\n99. a\n100. b");
  component.render(60);
  const markdown = markdownOf(component);
  markdown.options.preserveOrderedListMarkers = true;
  markdown.invalidate();
  assert.deepEqual(
    innerRows(component.render(60)).map((row) => plain(row).trim()),
    ["7) seven", "", "3) three", "", "+ plus", "", "* star", "", "99. a", "", "100. b"],
    "each one-item render still reads that item's own source marker",
  );
}

function testStreamingFrames() {
  const stream = `${FIXTURES.nested.src}\n\nThen\n- [ ] Task \`x\`\n- **Bold** end`;
  const live = newAssistant("");
  for (let end = 1; end <= stream.length; end += 1) {
    live.updateContent(assistantMessage(stream.slice(0, end)));
    const rows = innerRows(live.render(60));
    assert.ok(rows.every((row) => visibleWidth(row) <= 60), `stream frame ${end} fits`);
    assertNoDoubledGap(rows, `stream frame ${end}`);
  }
  assert.deepEqual(
    innerRows(live.render(60)).map(plain),
    innerRows(renderAssistant(stream, 60)).map(plain),
    "the last streamed frame equals a fresh render",
  );
}

function enableCodeCopyControls() {
  // The code-copy collector emits [Copy] only once it has seen fullscreen mode.
  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "fullscreen", copyTextToClipboard: async () => true } }, []);
  } catch {
    // The bare receiver has no session. The mode was recorded before the native method ran.
  }
}

function copyRegion(source) {
  const component = newAssistant(source);
  component.render(90);
  const markdown = markdownOf(component);
  const regionsKey = Object.getOwnPropertySymbols(markdown).find((symbol) => symbol.description === "pretty-tui.code-block-regions");
  assert.ok(regionsKey, "copy regions collected");
  const [region] = markdown[regionsKey];
  const press = (y) => markdown.handleMouse({
    type: "press", button: "left", x: region.xStart, y, width: 90, height: markdown.cachedLines.length,
  })?.handled === true;
  return { region, row: plain(markdown.cachedLines[region.y]), press };
}

function testCodeCopyFollowsAddedRows() {
  enableCodeCopyControls();
  const topLevel = copyRegion("Intro\n- A\n- B\n\n```ts\nconst copied = true;\n```");
  // Unspaced: Intro, A, B, blank, code frame = row 4. The list adds two gaps.
  assert.equal(topLevel.region.y, 6, "hit row follows the two added rows");
  assert.ok(topLevel.row.includes("[Copy]"), "the hit row holds [Copy]");
  assert.equal(topLevel.row.indexOf("[Copy]"), topLevel.region.xStart, "the hit column holds [Copy]");
  assert.equal(topLevel.press(topLevel.region.y), true, "a press on the moved control is handled");
  assert.notEqual(topLevel.press(topLevel.region.y - 2), true, "the unspaced row no longer holds the control");

  const inList = copyRegion("- Text\n  ```sh\n  ls\n  ```\n- Tail");
  // Unspaced: Text, code frame = row 1. The gap inside the item adds one.
  assert.equal(inList.region.y, 2, "in-list hit row follows its gap");
  assert.ok(inList.row.includes("[Copy]"), "the in-list hit row holds [Copy]");
  assert.equal(inList.press(inList.region.y), true, "an in-list press is handled");
}

async function testShutdownRestoresNative(extension, nativeMethods, native) {
  assert.notEqual(Markdown.prototype.renderList, nativeMethods.renderList, "the extension patched renderList");
  await extension.shutdown();
  for (const [name, method] of Object.entries(nativeMethods)) {
    assert.equal(Markdown.prototype[name], method, `shutdown restores Markdown.${name}`);
  }
  assert.equal(Markdown.prototype[Symbol.for("pretty-tui.list-bullets")], undefined, "shutdown drops the list patch key");
  initTheme("dark", false);
  assert.deepEqual(
    renderAssistant(FIXTURES.short.src, 90),
    native.assistant["dark/90/short"],
    "after shutdown Pi renders without the gaps again",
  );
}

testGapPolicy();
testRenderSpacedListOneItemAtATime();
testItemBlockGaps();
testItemJoinNeverDoubles();

const nativeMethods = Object.fromEntries(
  ["renderToken", "renderList", "render", "invalidate", "handleMouse"].map((name) => [name, Markdown.prototype[name]]),
);
const native = captureNative();
const extension = await loadExtension();
await testEveryFixtureInEveryMode(extension, native);
testGoldens();
testInlineStylesKept();
testOverlaysUntouched(native);
testCachedTokensAndRerenders();
testPreservedOrderedMarkers();
testStreamingFrames();
testCodeCopyFollowsAddedRows();
await testShutdownRestoresNative(extension, nativeMethods, native);

rmSync(agentDir, { recursive: true, force: true });
console.log("Markdown spacing tests passed.");

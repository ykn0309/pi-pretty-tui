// Theme colors for Markdown strong and emphasis, tested through Pi's real transcript
// and Markdown components. The `markdownEmphasis: "native"` opt-out is the oracle: the
// only allowed change is the foreground of strong and emphasis cells in assistant answers.
// Cells are compared by effective style, because equal output can have different bytes.
// Surfaces that must not change are compared byte for byte.
//
// To test against another Pi, set PI_HOST_MODULE and PI_TUI_MODULE to the dist/index.js
// of its pi-coding-agent and pi-tui packages.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// Set before Pi loads: chalk reads it once, and drops all styling off a TTY without it.
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const agentDir = mkdtempSync(join(tmpdir(), "pi-pretty-tui-emphasis-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const hostPath = process.env.PI_HOST_MODULE && resolve(process.env.PI_HOST_MODULE);
const tuiPath = process.env.PI_TUI_MODULE && resolve(process.env.PI_TUI_MODULE);
assert.equal(Boolean(hostPath), Boolean(tuiPath), "set PI_HOST_MODULE and PI_TUI_MODULE together");
const hostUrl = hostPath ? pathToFileURL(hostPath).href : import.meta.resolve("@earendil-works/pi-coding-agent");
const agent = await import(hostUrl);
const tui = await import(tuiPath ? pathToFileURL(tuiPath).href : "@earendil-works/pi-tui");
const { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, initTheme } = agent;
const { Markdown, getCapabilities, resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } = tui;
// Pi passes this same object to extensions as ctx.ui.theme. It follows the active theme.
const { theme: activeTheme } = await import(new URL("modes/interactive/theme/theme.js", hostUrl).href);
const jiti = createJiti(import.meta.url, hostPath
  ? { alias: { "@earendil-works/pi-coding-agent": hostPath, "@earendil-works/pi-tui": tuiPath } }
  : {});
const { MARKDOWN_EMPHASIS_COLORS, themedInlineContext, withNativeEmphasis } = await jiti.import(
  join(process.cwd(), "extensions/markdown-emphasis.ts"),
);

const CUSTOM_THEME = "emphasis-test-custom";
const THEMES = ["dark", "light", CUSTOM_THEME];
const HEADING_THEMES = [...THEMES, "system", "heading-palette", "heading-default"];
const MODES = ["clean", "compact", "full"];
const WIDTHS = [24, 40, 60, 120];
const URL_TARGET = "https://example.com/target";
const LONG = "several words that have to wrap across rows at a narrow terminal width";

const SPANS = [
  "plainA **strongA** plainB *italicA* plainC ***bothA*** plainD __strongU__ plainE _italicU_ plainF",
  "lead **oneA `codeA` twoA [linkA](https://example.com/target) threeA** tailA",
  "lead *oneB `codeB` twoB [linkB](https://example.com/target) threeB* tailB",
  "**outerC *innerC `codeC` backC* tailC** afterC",
  "*outerD **innerD `codeD` backD** tailD* afterD",
  "**outerE _innerE_ tailE** afterE and __outerF *innerF* tailF__ afterF",
  "[**linkG** plainlinkG *linkH*](https://example.com/target) afterG",
  "**[linkI](https://example.com/target)** afterI and **~~strikeJ~~ boldJ** afterJ",
  "**`onlyK`** afterK and `**literalL**` afterL and \\*\\*escapedM\\*\\* and snake_case_word afterM",
].join("\n\n");
const DOCUMENT = [
  SPANS,
  `**${LONG}** then *${LONG}* then plain`,
  "- **Lead:** item `code` text\n  - *nested* item\n- [ ] **task** done\n\n1. **ordered** one",
  "> quoted **strongQ** quoteA *italicQ* quoteB `codeQ` quoteC",
  `| **headStrong** | headPlain |\n|---|---|\n| *cellItalic* cellPlain | **${LONG}** cellTail |`,
  "```ts\nconst notEmphasis = \"**x** *y*\";\n```",
  "Soft **break\nacross** rows",
].join("\n\n");
const HEADINGS = [1, 2, 3, 4, 5, 6].map((level) =>
  `${"#".repeat(level)} Head **strong** *italic* \`code\` [link](${URL_TARGET}) tail`);
const STREAM = "Text **bold `code` *nested* end** tail\n\n- *item* [link](https://example.com) x\n\n| **a** |\n|---|\n| *b* |";
const THOUGHT = "**thoughtStrong** *thoughtItalic* `thoughtCode` thoughtPlain";
const USER_TEXT = "**userStrong** *userItalic* `userCode` userPlain";
const TOOL_TEXT = "**toolStrong** *toolItalic* toolPlain\n\n# toolHeading **x**";

function writeCustomTheme() {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL("modes/interactive/theme/dark.json", hostUrl)), "utf8"));
  Object.assign(base.colors, {
    syntaxNumber: "#ff0001", warning: "#00ff02", mdCode: "#0300ff", mdLink: "#ff00f4", mdQuote: "#555556", mdHeading: "#abcdef",
  });
  mkdirSync(join(agentDir, "themes"), { recursive: true });
  writeFileSync(join(agentDir, "themes", `${CUSTOM_THEME}.json`), JSON.stringify({ ...base, name: CUSTOM_THEME }));
  for (const [name, mdHeading] of [["heading-palette", 141], ["heading-default", ""]]) {
    writeFileSync(join(agentDir, "themes", `${name}.json`), JSON.stringify({
      ...base, name, colors: { ...base.colors, mdHeading },
    }));
  }
}

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

// One entry per grapheme with its effective style.
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

function spanCells(rows, text) {
  const ink = rows.flatMap(styledCells).filter((cell) => cell.grapheme.trim() !== "");
  const needle = [...segmenter.segment(text.replace(/\s+/g, ""))].map((entry) => entry.segment);
  const start = ink.findIndex((_, offset) => needle.every((grapheme, index) => ink[offset + index]?.grapheme === grapheme));
  assert.ok(start >= 0, `"${text}" rendered`);
  return ink.slice(start, start + needle.length);
}

const foregroundOf = (token) => styledCells(activeTheme.fg(token, "x"))[0].fg;

function expectSpan(rows, text, expected, label) {
  for (const cell of spanCells(rows, text)) {
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(cell[key], value, `${label}: "${text}" ${key}`);
    }
  }
}

function roles() {
  return {
    strong: foregroundOf(MARKDOWN_EMPHASIS_COLORS.strong),
    em: foregroundOf(MARKDOWN_EMPHASIS_COLORS.em),
    code: foregroundOf("mdCode"),
    link: foregroundOf("mdLink"),
    quote: foregroundOf("mdQuote"),
  };
}

// Every difference from the opt-out must be the foreground of a bold or italic cell, and must be an emphasis color.
function assertOnlyEmphasisForeground(rows, nativeRows, label) {
  assert.equal(rows.length, nativeRows.length, `${label}: row count`);
  const { strong, em } = roles();
  let changed = 0;
  rows.forEach((row, rowIndex) => {
    const cells = styledCells(row);
    const nativeCells = styledCells(nativeRows[rowIndex]);
    assert.equal(cells.map((cell) => cell.grapheme).join(""), nativeCells.map((cell) => cell.grapheme).join(""), `${label}: row ${rowIndex} text`);
    cells.forEach((cell, cellIndex) => {
      const native = nativeCells[cellIndex];
      assert.deepEqual({ ...cell, fg: null }, { ...native, fg: null }, `${label}: row ${rowIndex} cell ${cellIndex} attributes`);
      if (cell.fg === native.fg) return;
      changed += 1;
      assert.ok(cell.bold || cell.italic, `${label}: row ${rowIndex} cell ${cellIndex} "${cell.grapheme}" recolored without emphasis`);
      assert.ok(cell.fg === strong || cell.fg === em, `${label}: row ${rowIndex} cell ${cellIndex} "${cell.grapheme}" has fg ${cell.fg}`);
    });
  });
  return changed;
}

let messageStamp = 200_000;
const assistantMessage = (content) => ({
  role: "assistant", timestamp: messageStamp, stopReason: "stop",
  content: typeof content === "string" ? [{ type: "text", text: content }] : content,
});

function newAssistant(content) {
  messageStamp += 1;
  return new AssistantMessageComponent(assistantMessage(content));
}

const renderAssistant = (content, width) => newAssistant(content).render(width);
const markdownOf = (component) => component.contentContainer.children.find((child) => child instanceof Markdown);
const renderUser = (text, width) => new UserMessageComponent(text, getMarkdownTheme()).render(width);
const overlayRows = (src, width) => new Markdown(src, 0, 0, getMarkdownTheme()).render(width);
const bulletOpen = () => getMarkdownTheme().listBullet("\0").split("\0")[0];
const withPrettyBullets = (row) => row.replaceAll(`${bulletOpen()}- `, `${bulletOpen()}• `);

function renderToolMarkdown(width) {
  const tool = new ToolExecutionComponent(
    "markdown_tool", "emphasis-tool", {}, undefined,
    { renderShell: "self", renderCall: () => new Markdown(TOOL_TEXT, 0, 0, getMarkdownTheme()) },
    { requestRender() {} },
    process.cwd(),
  );
  return tool.render(width);
}

// Markdown drawn while the assistant renders, but not owned by it, as a third-party child would be.
function renderForeignChild(width) {
  const component = newAssistant("assistant body");
  component.contentContainer.addChild(new Markdown(TOOL_TEXT, 0, 0, getMarkdownTheme()));
  const rows = component.render(width);
  const start = rows.findIndex((row) => stripTerminalSequences(row).includes("toolStrong"));
  assert.ok(start >= 0, "the foreign child rendered");
  return rows.slice(start);
}

function renderStreamFrames(width) {
  const live = newAssistant("x");
  const frames = [];
  for (let end = 1; end <= STREAM.length; end += 1) {
    live.updateContent(assistantMessage(STREAM.slice(0, end)), true);
    frames.push(live.render(width));
  }
  return frames;
}

const renderings = (width) => ({
  document: renderAssistant(DOCUMENT, width),
  spans: renderAssistant(SPANS, 200),
  stream: renderStreamFrames(width),
  thought: renderAssistant([{ type: "thinking", thinking: THOUGHT }], width),
  mixedThought: renderAssistant([{ type: "thinking", thinking: THOUGHT }, { type: "text", text: "**bodyStrong** bodyPlain" }], width),
  headings: HEADINGS.map((source) => renderAssistant(source, width)),
  user: renderUser(USER_TEXT, width),
  tool: renderToolMarkdown(width),
  foreign: renderForeignChild(width),
  overlay: overlayRows(DOCUMENT, width),
});

function sessionUi() {
  return { getToolsExpanded: () => false, notify() {}, setWidget() {}, theme: activeTheme };
}

async function loadExtension(configJson) {
  writeFileSync(join(agentDir, "pretty-tui.json"), JSON.stringify(configJson));
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
  const ctx = { hasUI: true, ui: sessionUi(), sessionManager: { buildContextEntries: () => [], getBranch: () => [] } };
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  return {
    setMode: (mode) => commands.get("pretty-tui").handler(mode, ctx),
    shutdown: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

async function eachCombination(extension, callback) {
  for (const theme of THEMES) {
    initTheme(theme, false);
    for (const mode of MODES) {
      await extension.setMode(mode);
      for (const width of WIDTHS) await callback(`${theme}/${mode}/${width}`, theme, mode, width);
    }
  }
  await extension.setMode("clean");
  initTheme("dark", false);
}

function testContextIsPureAndOwnerAware() {
  assert.deepEqual(MARKDOWN_EMPHASIS_COLORS, { strong: "syntaxNumber", em: "warning" });
  const theme = { fg: (color, text) => `<${color}>${text}</>` };
  const root = { applyText: (text) => `[${text}]`, stylePrefix: "<root>" };
  const strongChildren = Object.freeze([{ type: "text", text: "x" }]);
  const linkChildren = Object.freeze([{ type: "text", text: "y" }]);
  const emChildren = Object.freeze([]);
  const parent = Object.freeze([
    Object.freeze({ type: "strong", tokens: strongChildren }),
    Object.freeze({ type: "link", tokens: linkChildren }),
    Object.freeze({ type: "em", tokens: emChildren }),
  ]);
  assert.equal(themedInlineContext(parent, root, theme), root, "tokens with no emphasis parent keep their context");
  const strong = themedInlineContext(strongChildren, root, theme);
  assert.equal(strong.applyText("t"), "[<syntaxNumber>t</>]", "the inner color wins over a surrounding style");
  assert.equal(strong.stylePrefix, "<root><syntaxNumber>", "a nested close restores the surrounding style, then the color");
  const em = themedInlineContext(emChildren, root, theme);
  assert.equal(em.applyText("t"), "[<warning>t</>]");
  const linkInsideStrong = themedInlineContext(linkChildren, strong, theme);
  assert.equal(linkInsideStrong.applyText("t"), "[t]", "a link label escapes the emphasis color");
  assert.equal(linkInsideStrong.stylePrefix, "<root>");
  const strongInsideLink = themedInlineContext(strongChildren, linkInsideStrong, theme);
  assert.equal(strongInsideLink, linkInsideStrong, "emphasis inside a link keeps the link color");
  const heading = withNativeEmphasis({ ...root });
  assert.equal(themedInlineContext(strongChildren, heading, theme), heading, "a heading context keeps its own color");
  const innerEm = themedInlineContext(emChildren, strong, theme);
  assert.equal(innerEm.applyText("t"), "[<warning>t</>]", "the innermost emphasis replaces the outer color");
  assert.equal(innerEm.stylePrefix, "<root><warning>", "colors do not pile up");
}

function testThemeTokensAreDistinct() {
  for (const theme of THEMES) {
    initTheme(theme, false);
    const { strong, em, code, link } = roles();
    assert.equal(new Set([strong, em, code, link]).size, 4, `${theme}: strong, emphasis, code and link colors differ`);
  }
  initTheme(CUSTOM_THEME, false);
  assert.equal(roles().strong, "38;2;255;0;1", "the custom theme's own strong color is used");
  assert.equal(roles().em, "38;2;0;255;2", "the custom theme's own emphasis color is used");
  initTheme("dark", false);
}

function testSpanStyles(rows, nativeRows, label) {
  const { strong, em, code, link } = roles();
  const body = (word) => spanCells(nativeRows, word)[0].fg;
  const plainWords = ["plainA", "plainB", "plainC", "plainD", "plainE", "plainF", "tailA", "tailB", "afterC", "afterD", "afterE", "afterF",
    "afterG", "afterI", "afterJ", "afterK", "afterL", "escapedM", "snake_case_word", "afterM"];
  for (const word of plainWords) expectSpan(rows, word, { fg: body(word), bold: false, italic: false, underline: false }, label);

  for (const word of ["strongA", "strongU"]) expectSpan(rows, word, { fg: strong, bold: true, italic: false, underline: false }, label);
  for (const word of ["italicA", "italicU"]) expectSpan(rows, word, { fg: em, bold: false, italic: true, underline: false }, label);
  expectSpan(rows, "bothA", { fg: strong, bold: true, italic: true }, label);

  // Each close returns to emphasis, and the emphasis close returns to the body.
  for (const word of ["oneA", "twoA", "threeA"]) expectSpan(rows, word, { fg: strong, bold: true, italic: false, underline: false }, label);
  expectSpan(rows, "codeA", { fg: code, bold: true, italic: false }, label);
  expectSpan(rows, "linkA", { fg: link, bold: true, underline: true }, label);
  for (const word of ["oneB", "twoB", "threeB"]) expectSpan(rows, word, { fg: em, italic: true, bold: false, underline: false }, label);
  expectSpan(rows, "codeB", { fg: code, italic: true, bold: false }, label);
  expectSpan(rows, "linkB", { fg: link, italic: true, underline: true }, label);

  // Both nesting orders: flags combine, and the innermost foreground wins.
  expectSpan(rows, "outerC", { fg: strong, bold: true, italic: false }, label);
  expectSpan(rows, "innerC", { fg: em, bold: true, italic: true }, label);
  expectSpan(rows, "codeC", { fg: code, bold: true, italic: true }, label);
  expectSpan(rows, "backC", { fg: em, bold: true, italic: true }, label);
  expectSpan(rows, "tailC", { fg: strong, bold: true, italic: false }, label);
  expectSpan(rows, "outerD", { fg: em, italic: true, bold: false }, label);
  expectSpan(rows, "innerD", { fg: strong, bold: true, italic: true }, label);
  expectSpan(rows, "codeD", { fg: code, bold: true, italic: true }, label);
  expectSpan(rows, "backD", { fg: strong, bold: true, italic: true }, label);
  expectSpan(rows, "tailD", { fg: em, italic: true, bold: false }, label);
  expectSpan(rows, "innerE", { fg: em, bold: true, italic: true }, label);
  expectSpan(rows, "tailE", { fg: strong, bold: true, italic: false }, label);
  expectSpan(rows, "innerF", { fg: em, bold: true, italic: true }, label);
  expectSpan(rows, "tailF", { fg: strong, bold: true, italic: false }, label);

  // Emphasis inside a link keeps Pi's link color and its own flags.
  expectSpan(rows, "linkG", { fg: link, bold: true, italic: false, underline: true }, label);
  expectSpan(rows, "plainlinkG", { fg: link, bold: false, italic: false, underline: true }, label);
  expectSpan(rows, "linkH", { fg: link, italic: true, bold: false, underline: true }, label);
  expectSpan(rows, "linkI", { fg: link, bold: true, underline: true }, label);
  expectSpan(rows, "strikeJ", { fg: strong, bold: true, strike: true }, label);
  expectSpan(rows, "boldJ", { fg: strong, bold: true, strike: false }, label);
  expectSpan(rows, "onlyK", { fg: code, bold: true }, label);
  expectSpan(rows, "**literalL**", { fg: code, bold: false, italic: false }, label);
}

async function testEveryCombination(extension, optOut) {
  await eachCombination(extension, (label, theme, mode, width) => {
    const rendered = renderings(width);
    const native = optOut[label];
    assert.ok(rendered.document.every((row) => visibleWidth(row) <= width), `${label}: fits width`);
    assert.ok(assertOnlyEmphasisForeground(rendered.document, native.document, `${label}/document`) > 0, `${label}: the document is recolored`);
    assert.ok(assertOnlyEmphasisForeground(rendered.spans, native.spans, `${label}/spans`) > 0, `${label}: spans are recolored`);
    testSpanStyles(rendered.spans, native.spans, `${label}/spans`);
    assert.equal(rendered.stream.length, native.stream.length, `${label}: stream frames`);
    rendered.stream.forEach((frame, index) => assertOnlyEmphasisForeground(frame, native.stream[index], `${label}/stream ${index}`));

    for (const surface of ["thought", "user", "tool", "foreign", "overlay"]) {
      assert.deepEqual(rendered[surface], native[surface], `${label}: ${surface} Markdown stays byte-identical`);
    }
    assert.deepEqual(rendered.headings, native.headings, `${label}: headings stay byte-identical`);
    const thoughtRows = (rows) => rows.filter((row) => stripTerminalSequences(row).includes("thought"));
    assert.deepEqual(thoughtRows(rendered.mixedThought), thoughtRows(native.mixedThought), `${label}: thinking next to an answer stays byte-identical`);
  });
}

function testBlockStyles() {
  for (const theme of THEMES) {
    initTheme(theme, false);
    const { strong, em, code, quote } = roles();
    const rows = renderAssistant(DOCUMENT, 120);
    const label = `${theme}/blocks`;
    expectSpan(rows, "Lead:", { fg: strong, bold: true }, label);
    expectSpan(rows, "item", { bold: false, italic: false }, label);
    expectSpan(rows, "nested", { fg: em, italic: true }, label);
    expectSpan(rows, "task", { fg: strong, bold: true }, label);
    expectSpan(rows, "ordered", { fg: strong, bold: true }, label);
    expectSpan(rows, "strongQ", { fg: strong, bold: true, italic: true }, label);
    expectSpan(rows, "italicQ", { fg: em, italic: true }, label);
    expectSpan(rows, "codeQ", { fg: code }, label);
    for (const word of ["quoted", "quoteA", "quoteB", "quoteC"]) expectSpan(rows, word, { fg: quote, italic: true, bold: false }, label);
    expectSpan(rows, "headStrong", { fg: strong, bold: true }, label);
    expectSpan(rows, "headPlain", { bold: true }, label);
    assert.notEqual(spanCells(rows, "headPlain")[0].fg, strong, `${label}: a table header's bold is not strong`);
    expectSpan(rows, "cellItalic", { fg: em, italic: true }, label);
    expectSpan(rows, "cellPlain", { italic: false, bold: false }, label);
    expectSpan(rows, "cellTail", { bold: false }, label);
    expectSpan(rows, "Soft", { bold: false }, label);
    expectSpan(rows, "across", { fg: strong, bold: true }, label);
    expectSpan(rows, "notEmphasis", { bold: false, italic: false }, label);
    assert.ok(!spanCells(rows, "**x**").some((cell) => cell.fg === strong), `${label}: a code fence is not recolored`);
    assert.ok(spanCells(rows, "**x**").every((cell) => !cell.bold), `${label}: a code fence is not bold`);
  }
  initTheme("dark", false);
}

function testWrappedEmphasisKeepsColor() {
  const { strong, em } = roles();
  for (const width of [24, 40]) {
    const rows = renderAssistant(`**${LONG}** after *${LONG}* end`, width);
    assert.ok(rows.length > 4, "the text wraps");
    const words = LONG.split(" ");
    const cells = rows.flatMap(styledCells).filter((cell) => cell.grapheme.trim() !== "");
    const text = cells.map((cell) => cell.grapheme).join("");
    const length = LONG.replace(/\s+/g, "").length;
    const firstStart = text.indexOf(words.join(""));
    const secondStart = text.indexOf(words.join(""), firstStart + 1);
    assert.ok(cells.slice(firstStart, firstStart + length).every((cell) => cell.fg === strong && cell.bold), `${width}: strong color spans its wrapped rows`);
    assert.ok(cells.slice(secondStart, secondStart + length).every((cell) => cell.fg === em && cell.italic), `${width}: emphasis color spans its wrapped rows`);
    expectSpan(rows, "after", { bold: false, italic: false, fg: null }, `${width}`);
    expectSpan(rows, "end", { bold: false, italic: false, fg: null }, `${width}`);
    const last = rows.filter((row) => stripTerminalSequences(row).trim() !== "").at(-1);
    assert.equal(styledCells(`${last}x`).at(-1).fg, null, `${width}: no color leaks past the answer`);
    assert.equal(styledCells(`${last}x`).at(-1).bold, false, `${width}: no bold leaks past the answer`);
  }
}

// With no terminal colors, the system theme uses palette indexes and draws some tokens faint.
// A faint token's close also ends bold, so the chosen tokens must keep the flags across a nested close.
function testSystemThemeWithoutTerminalColors() {
  initTheme("system", false);
  const { strong, em, code } = roles();
  assert.ok(strong !== null && em !== null, "the system theme gives both tokens a color");
  const rows = renderAssistant("x **oneS `codeS` twoS *innerS* threeS** y *oneT `codeT` twoT* z", 120);
  for (const word of ["oneS", "twoS", "threeS"]) expectSpan(rows, word, { fg: strong, bold: true, dim: false, italic: false }, "system");
  expectSpan(rows, "codeS", { fg: code, bold: true }, "system");
  expectSpan(rows, "innerS", { fg: em, bold: true, italic: true, dim: false }, "system");
  for (const word of ["oneT", "twoT"]) expectSpan(rows, word, { fg: em, italic: true, bold: false, dim: false }, "system");
  expectSpan(rows, "codeT", { fg: code, italic: true }, "system");
  for (const word of ["x", "y", "z"]) expectSpan(rows, word, { fg: null, bold: false, italic: false }, "system");
  initTheme("dark", false);
}

function testHyperlinkCapability() {
  const capabilities = getCapabilities();
  const { strong, link } = roles();
  for (const hyperlinks of [false, true]) {
    setCapabilities({ ...capabilities, hyperlinks });
    const rows = renderAssistant(`**before [linkword](${URL_TARGET}) after**`, 120);
    assert.equal(rows.join("").includes("\x1b]8;"), hyperlinks, `hyperlinks ${hyperlinks}: link form`);
    expectSpan(rows, "before", { fg: strong, bold: true }, `hyperlinks ${hyperlinks}`);
    expectSpan(rows, "linkword", { fg: link, bold: true, underline: true }, `hyperlinks ${hyperlinks}`);
    expectSpan(rows, "after", { fg: strong, bold: true, underline: false }, `hyperlinks ${hyperlinks}`);
  }
  resetCapabilitiesCache();
}

function testThemeSwitch() {
  initTheme("dark", false);
  const component = newAssistant("Before **strongS** middle *italicS* end");
  const paint = () => ({ strong: spanCells(component.render(90), "strongS")[0].fg, em: spanCells(component.render(90), "italicS")[0].fg });
  const dark = roles();
  assert.deepEqual(paint(), { strong: dark.strong, em: dark.em }, "dark colors");
  const before = markdownOf(component);
  initTheme("light", false);
  const light = roles();
  assert.notDeepEqual([light.strong, light.em], [dark.strong, dark.em]);
  before.invalidate();
  assert.deepEqual(paint(), { strong: light.strong, em: light.em }, "invalidating one Markdown picks up the new theme");
  initTheme(CUSTOM_THEME, false);
  component.invalidate();
  const custom = roles();
  assert.deepEqual(paint(), { strong: custom.strong, em: custom.em }, "Pi's theme-change invalidation rebuilds with the new theme");
  initTheme("dark", false);
  component.invalidate();
  assert.deepEqual(paint(), { strong: dark.strong, em: dark.em }, "switching back restores the colors");
}

function testNoSharedStateIsMutated() {
  const source = "**strongN** *italicN* `codeN` plainN";
  const markdownTheme = getMarkdownTheme();
  const themeMethods = { ...markdownTheme };
  const component = new AssistantMessageComponent(assistantMessage(source), false, markdownTheme);
  const first = [...component.render(90)];
  const markdown = markdownOf(component);
  const tokensBefore = JSON.stringify(markdown.cachedTokens.deref().tokens);
  markdown.invalidate();
  assert.deepEqual([...component.render(90)], first, "a re-render is stable");
  assert.equal(JSON.stringify(markdown.cachedTokens.deref().tokens), tokensBefore, "cached tokens are not mutated");
  assert.equal(markdown.text, source, "the Markdown source is not rewritten");
  for (const [name, method] of Object.entries(themeMethods)) {
    assert.equal(markdownTheme[name], method, `Markdown theme method ${name} is not replaced`);
  }
}

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

// Frozen tokens make any write to them throw, because this file and Pi's dist are strict-mode ESM.
function testFrozenTokensRenderIdentically() {
  const source = `${SPANS}\n\n- **list \`code\`** item\n\n| **a** |\n|---|\n| *b* |\n\n> *quote*`;
  const component = newAssistant(source);
  const first = [...component.render(60)];
  const markdown = markdownOf(component);
  const held = markdown.cachedTokens.deref();
  const before = JSON.stringify(held.tokens);
  deepFreeze(held);
  markdown.invalidate();
  assert.equal(markdown.cachedTokens.deref(), held, "the frozen parse is the one being reused");
  assert.deepEqual([...component.render(60)], first, "frozen tokens render the same rows");
  component.render(90);
  assert.deepEqual([...component.render(60)], first, "and again after a width change");
  assert.equal(JSON.stringify(held.tokens), before, "the tokens are unchanged");
  assert.equal(markdown.text, source, "the source is unchanged");
}

// Ancestry is per token array, so depth and shared parents must not confuse it.
function testDeepAncestry() {
  const { strong, em, code, link } = roles();
  const target = "https://example.com/target";
  const rows = renderAssistant([
    `**aOne [*bOne* **cOne** \`dOne\`](${target}) *eOne [fOne](${target}) gOne \`hOne\` iOne* jOne** kOne`,
    `*aTwo **bTwo [cTwo](${target}) dTwo *eTwo* fTwo** gTwo* hTwo`,
    `~~**aThree** bThree *cThree [dThree](${target}) eThree*~~ fThree`,
    `***aFour [bFour](${target}) cFour*** dFour **aFive** eFive *aSix* fSix`,
  ].join("\n\n"), 200);
  const expected = [
    ["aOne", strong, { bold: true, italic: false }],
    ["bOne", link, { bold: true, italic: true, underline: true }],
    ["cOne", link, { bold: true, italic: false, underline: true }],
    ["dOne", code, { bold: true, italic: false, underline: true }],
    ["eOne", em, { bold: true, italic: true, underline: false }],
    ["fOne", link, { bold: true, italic: true, underline: true }],
    ["gOne", em, { bold: true, italic: true, underline: false }],
    ["hOne", code, { bold: true, italic: true }],
    ["iOne", em, { bold: true, italic: true }],
    ["jOne", strong, { bold: true, italic: false }],
    ["kOne", null, { bold: false, italic: false }],
    ["aTwo", em, { bold: false, italic: true }],
    ["bTwo", strong, { bold: true, italic: true }],
    ["cTwo", link, { bold: true, italic: true, underline: true }],
    ["dTwo", strong, { bold: true, italic: true, underline: false }],
    ["eTwo", em, { bold: true, italic: true }],
    ["fTwo", strong, { bold: true, italic: true }],
    ["gTwo", em, { bold: false, italic: true }],
    ["hTwo", null, { bold: false, italic: false }],
    ["aThree", strong, { bold: true, strike: true }],
    ["bThree", null, { bold: false, strike: true }],
    ["cThree", em, { italic: true, strike: true }],
    ["dThree", link, { italic: true, strike: true, underline: true }],
    ["eThree", em, { italic: true, strike: true, underline: false }],
    ["fThree", null, { italic: false, strike: false }],
    ["aFour", strong, { bold: true, italic: true }],
    ["bFour", link, { bold: true, italic: true, underline: true }],
    ["cFour", strong, { bold: true, italic: true }],
    ["dFour", null, { bold: false, italic: false }],
    ["aFive", strong, { bold: true, italic: false }],
    ["eFive", null, { bold: false }],
    ["aSix", em, { italic: true, bold: false }],
    ["fSix", null, { italic: false, bold: false }],
  ];
  for (const [word, fg, flags] of expected) expectSpan(rows, word, { fg, ...flags }, "ancestry");
}

// Nested closes must survive being split across rows, in both emphasis kinds.
function testWrappedNestedSpans() {
  const { strong, em, code, link } = roles();
  const filler = "alpha beta gamma delta epsilon zeta eta theta";
  const source = `**${filler} \`wrapcode wrapcode\` ${filler} [wraplink wraplink](https://example.com/target) ${filler}** tailword`
    + `\n\n*${filler} \`wrapcodeb\` ${filler} **${filler}** ${filler}* endword`;
  for (const width of [18, 24, 40]) {
    const rows = renderAssistant(source, width);
    assert.ok(rows.every((row) => visibleWidth(row) <= width), `${width}: fits`);
    const cells = rows.flatMap(styledCells).filter((cell) => cell.grapheme.trim() !== "");
    const text = cells.map((cell) => cell.grapheme).join("");
    const squeezed = filler.replace(/\s+/g, "");
    const fillerStarts = [];
    for (let at = text.indexOf(squeezed); at >= 0; at = text.indexOf(squeezed, at + 1)) fillerStarts.push(at);
    assert.equal(fillerStarts.length, 7, `${width}: all filler rendered`);
    const fillerStyle = (index) => cells.slice(fillerStarts[index], fillerStarts[index] + squeezed.length);
    for (const index of [0, 1, 2]) {
      assert.ok(fillerStyle(index).every((cell) => cell.fg === strong && cell.bold && !cell.italic), `${width}: strong filler ${index}`);
    }
    for (const index of [3, 4, 6]) {
      assert.ok(fillerStyle(index).every((cell) => cell.fg === em && cell.italic && !cell.bold), `${width}: emphasis filler ${index}`);
    }
    assert.ok(fillerStyle(5).every((cell) => cell.fg === strong && cell.italic && cell.bold), `${width}: strong filler nested in emphasis`);
    expectSpan(rows, "wrapcode wrapcode", { fg: code, bold: true }, `${width}`);
    expectSpan(rows, "wraplink wraplink", { fg: link, bold: true, underline: true }, `${width}`);
    expectSpan(rows, "wrapcodeb", { fg: code, italic: true, bold: false }, `${width}`);
    expectSpan(rows, "tailword", { fg: null, bold: false }, `${width}`);
    expectSpan(rows, "endword", { fg: null, italic: false }, `${width}`);
  }
}

// Assert the heading policy independently of the emphasis opt-out oracle.
// Only H2 changes; H3–H6 keep their differentiated native treatments.
// Panel backgrounds are legitimate; headings must not add one.
async function testThemeCompliantHeadings(extension) {
  for (const theme of HEADING_THEMES) {
    initTheme(theme, false);
    for (const mode of MODES) {
      await extension.setMode(mode);
      for (let level = 2; level <= 6; level++) {
        const source = `${"#".repeat(level)} HeadW **StrongW** *ItalicW* \`CodeW\` [LinkW](${URL_TARGET}) TailW\n\nBodyW`;
        for (const width of [40, 90]) {
          const component = newAssistant(source);
          const rows = component.render(width);
          const label = `${theme}/${mode}/H${level}/${width}`;
          const foreground = foregroundOf(level === 6 ? "mdQuote" : "mdHeading");
          const background = spanCells(rows, "BodyW")[0].bg;
          const headingStyle = {
            fg: foreground, bg: background, bold: level <= 4,
            italic: level === 6, underline: level === 3, inverse: false,
          };
          for (const word of ["HeadW", "TailW"]) expectSpan(rows, word, headingStyle, label);
          expectSpan(rows, "StrongW", { ...headingStyle, bold: true }, label);
          expectSpan(rows, "ItalicW", { ...headingStyle, italic: true }, label);
          expectSpan(rows, "CodeW", { fg: foregroundOf("mdCode"), bold: false, italic: false }, label);
          // The surrounding heading context owns the link-label foreground.
          expectSpan(rows, "LinkW", { ...headingStyle, underline: true }, label);
          if (level === 5) {
            assert.equal(rows.map(stripTerminalSequences).join("\n").match(/┄┄/g)?.length, 2,
              `${label}: H5 retains its opening and closing dashes`);
          }
          expectSpan(rows, "BodyW", { bold: false, italic: false, underline: false, inverse: false }, label);
          assert.ok(rows.every((row) => visibleWidth(row) <= width), `${label}: fits width`);
          assert.equal(markdownOf(component).text, source, `${label}: Markdown source stays unchanged`);
        }
      }
    }
  }

  await extension.setMode("clean");
  initTheme("dark", false);
  for (const heading of ["## LevelW", "LevelW\n---", "## LevelW ##"]) {
    for (const gap of ["\n", "\n\n"]) {
      const rows = renderAssistant(`${heading}${gap}BodyW`, 90).map(stripTerminalSequences);
      assert.deepEqual(rows.map((row) => row.trim()).filter(Boolean), ["LevelW", "BodyW"], "ATX/setext/closing markers stay hidden");
      assert.equal(rows.findIndex((row) => row.trim() === "BodyW") - rows.findIndex((row) => row.trim() === "LevelW"), 2,
        "a heading and paragraph have one blank row");
    }
  }
  for (let level = 2; level <= 6; level++) {
    for (const width of [6, 12, 24]) {
      const rows = renderAssistant(`${"#".repeat(level)} AlphaW BetaW GammaW`, width);
      assert.ok(rows.every((row) => visibleWidth(row) <= width), `H${level}/${width}: wraps within width`);
      for (const word of ["AlphaW", "BetaW", "GammaW"]) {
        expectSpan(rows, word, {
          fg: foregroundOf(level === 6 ? "mdQuote" : "mdHeading"), bold: level <= 4,
          italic: level === 6, underline: level === 3, bg: null, inverse: false,
        }, `H${level}/${width}: wrapped rows retain heading style`);
      }
    }
  }

  // The same component must follow theme changes, including palette/default
  // foregrounds; the renderer must never infer a background from luminance.
  const component = newAssistant("## SwitchW");
  for (const theme of ["dark", "light", CUSTOM_THEME, "heading-palette", "heading-default"]) {
    initTheme(theme, false);
    component.invalidate();
    expectSpan(component.render(90), "SwitchW", {
      fg: foregroundOf("mdHeading"), bold: true, bg: null, inverse: false, underline: false,
    }, `${theme}: heading follows theme switch`);
  }
  initTheme("dark", false);
  const primary = renderAssistant("# PrimaryW", 90);
  assert.ok(primary.some((row) => stripTerminalSequences(row).includes("╔")), "H1 retains its frame");
  expectSpan(primary, "PrimaryW", { fg: foregroundOf("mdHeading"), bold: true, underline: true }, "H1 retains its title styling");
}

function testCopyControlFollowsSameRow() {
  try {
    InteractiveMode.prototype.renderSessionEntries.call({ ui: { mode: "fullscreen", copyTextToClipboard: async () => true } }, []);
  } catch {
    // The bare receiver has no session. The mode was recorded before the native method ran.
  }
  const component = newAssistant("## Heading above code\n\n##### Another heading\n\n###### Last heading\n\n**Lead** and *more*\n\n```ts\nconst copied = true;\n```");
  component.render(90);
  const markdown = markdownOf(component);
  const regionsKey = Object.getOwnPropertySymbols(markdown).find((symbol) => symbol.description === "pretty-tui.code-block-regions");
  const [region] = markdown[regionsKey];
  const row = stripTerminalSequences(markdown.cachedLines[region.y]);
  assert.equal(row.indexOf("[Copy]"), region.xStart, "the copy hit column holds [Copy]");
  assert.equal(region.code, "const copied = true;", "copied code is the source text");
}

function testOverlayRenderOfAssistantMarkdown() {
  const component = newAssistant("**strongO** *italicO*");
  component.render(90);
  const markdown = markdownOf(component);
  const { strong } = roles();
  const unscoped = markdown.render(90);
  assert.ok(spanCells(unscoped, "strongO").every((cell) => cell.bold && cell.fg !== strong), "outside the transcript scope it stays native");
  assert.ok(spanCells(component.render(90), "strongO").every((cell) => cell.fg === strong), "back in the transcript the color returns");
}

const colored = (rows, word) => spanCells(rows, word).every((cell) => cell.fg === roles().strong);

// Answer nodes can outlive a runtime: Pi may keep a component that was built, and
// whose Markdown cached its rows, before this extension or this runtime loaded.
async function testComponentsAcrossLoadAndReload(nativeRender) {
  assert.equal(Markdown.prototype.renderInlineTokens, nativeRender);
  initTheme("dark", false);

  for (const mode of MODES) {
    const history = new AssistantMessageComponent(assistantMessage("**oldStrong** *oldItalic* oldPlain"));
    const cachedBeforeLoad = [...history.render(90)];
    assert.ok(!colored(cachedBeforeLoad, "oldStrong"), `${mode}: native rows before the extension loads`);
    const staleNode = markdownOf(history);
    assert.ok(staleNode.cachedLines, `${mode}: the node cached its rows before load`);

    const first = await loadExtension({ mode });
    assert.ok(colored(history.render(90), "oldStrong"), `${mode}: a component built before load gets colors with no invalidate`);
    assert.equal(spanCells(history.render(90), "oldItalic")[0].fg, roles().em, `${mode}: and emphasis`);
    assert.equal(spanCells(history.render(90), "oldPlain")[0].bold, false, `${mode}: plain text stays plain`);

    await first.shutdown();
    const second = await loadExtension({ mode });
    assert.ok(colored(history.render(90), "oldStrong"), `${mode}: a component survives a reload with colors`);

    // A node cached by the last runtime, reused by the next without updateContent running first.
    const cachedNode = new AssistantMessageComponent(assistantMessage("**keptStrong** keptPlain"));
    assert.ok(colored(cachedNode.render(90), "keptStrong"), `${mode}: colored in this runtime`);
    await second.shutdown();

    const optedOut = await loadExtension({ mode, markdownEmphasis: "native" });
    assert.ok(!colored(history.render(90), "oldStrong"), `${mode}: reloading into the opt-out drops colors from cached rows`);
    assert.ok(!colored(cachedNode.render(90), "keptStrong"), `${mode}: for every kept component`);
    assert.ok(spanCells(history.render(90), "oldStrong").every((cell) => cell.bold), `${mode}: and keeps native bold`);
    await optedOut.shutdown();

    const third = await loadExtension({ mode });
    assert.ok(colored(history.render(90), "oldStrong"), `${mode}: reloading out of the opt-out restores colors`);
    assert.ok(colored(cachedNode.render(90), "keptStrong"), `${mode}: for every kept component`);
    await third.shutdown();

    initTheme("dark", false);
    history.invalidate();
    assert.ok(!colored(history.render(90), "oldStrong"), `${mode}: native again after the final shutdown`);
  }
  assert.equal(Markdown.prototype.renderInlineTokens, nativeRender);
}

async function testShutdownRestoresNative(extension, nativeRender, nativeBaseline) {
  assert.notEqual(Markdown.prototype.renderInlineTokens, nativeRender, "the extension patched renderInlineTokens");
  await extension.shutdown();
  assert.equal(Markdown.prototype.renderInlineTokens, nativeRender, "shutdown restores renderInlineTokens");
  assert.equal(Markdown.prototype[Symbol.for("pretty-tui.inline-emphasis")], undefined, "shutdown drops the patch key");
  initTheme("dark", false);
  assert.deepEqual(renderAssistant(SPANS, 90), nativeBaseline, "after shutdown Pi renders as it did before the extension");
}

async function testCoexistence(nativeRender) {
  const calls = [];
  const underlying = function (tokens, context) {
    calls.push("under");
    return nativeRender.call(this, tokens, context);
  };
  Markdown.prototype.renderInlineTokens = underlying;
  const extension = await loadExtension({});
  assert.notEqual(Markdown.prototype.renderInlineTokens, underlying);
  const { strong } = roles();
  assert.ok(spanCells(renderAssistant("**strongX**", 90), "strongX").every((cell) => cell.fg === strong), "colors work on top of another patch");
  assert.ok(calls.length > 0, "another extension's earlier patch still runs");
  calls.length = 0;
  overlayRows("**strongX**", 90);
  assert.ok(calls.length > 0, "and runs for overlays");

  const ours = Markdown.prototype.renderInlineTokens;
  const later = function (tokens, context) {
    return ours.call(this, tokens, context);
  };
  Markdown.prototype.renderInlineTokens = later;
  await extension.shutdown();
  assert.equal(Markdown.prototype.renderInlineTokens, later, "shutdown leaves a later patch in place");
  Markdown.prototype.renderInlineTokens = nativeRender;

  Markdown.prototype.renderInlineTokens = underlying;
  const again = await loadExtension({});
  await again.shutdown();
  assert.equal(Markdown.prototype.renderInlineTokens, underlying, "shutdown restores an earlier patch");
  Markdown.prototype.renderInlineTokens = nativeRender;
}

async function testDisabledInstallsNothing(nativeRender) {
  const extension = await loadExtension({ enabled: false });
  assert.equal(Markdown.prototype.renderInlineTokens, nativeRender, "a disabled extension does not patch");
  await extension.shutdown();
}

testContextIsPureAndOwnerAware();
writeCustomTheme();
testThemeTokensAreDistinct();

const nativeRender = Markdown.prototype.renderInlineTokens;
initTheme("dark", false);
const nativeBaseline = renderAssistant(SPANS, 90);
const nativeOverlay = overlayRows(DOCUMENT, 50);
const nativeHeadingOverlays = HEADINGS.map((source) => overlayRows(source, 50));

const optOutExtension = await loadExtension({ markdownEmphasis: "native" });
assert.equal(Markdown.prototype.renderInlineTokens, nativeRender, "the opt-out installs no patch");
assert.deepEqual(overlayRows(DOCUMENT, 50), nativeOverlay.map(withPrettyBullets), "overlays match native with the opt-out");
const optOut = {};
await eachCombination(optOutExtension, (label, _theme, _mode, width) => {
  optOut[label] = renderings(width);
});
const flagsOnly = renderAssistant("x **strongZ** *italicZ*", 90);
assert.ok(spanCells(flagsOnly, "strongZ").every((cell) => cell.bold && cell.fg === null), "the opt-out keeps Pi's flags-only strong");
assert.ok(spanCells(flagsOnly, "italicZ").every((cell) => cell.italic && cell.fg === null), "the opt-out keeps Pi's flags-only emphasis");
await optOutExtension.shutdown();

const extension = await loadExtension({});
await testEveryCombination(extension, optOut);
assert.deepEqual(overlayRows(DOCUMENT, 50), nativeOverlay.map(withPrettyBullets), "overlays stay native");
testBlockStyles();
await testThemeCompliantHeadings(extension);
assert.deepEqual(HEADINGS.map((source) => overlayRows(source, 50)), nativeHeadingOverlays, "heading changes do not leak into overlays");
testWrappedEmphasisKeepsColor();
testSystemThemeWithoutTerminalColors();
testHyperlinkCapability();
testThemeSwitch();
testNoSharedStateIsMutated();
testFrozenTokensRenderIdentically();
testDeepAncestry();
testWrappedNestedSpans();
testCopyControlFollowsSameRow();
testOverlayRenderOfAssistantMarkdown();
await testShutdownRestoresNative(extension, nativeRender, nativeBaseline);
await testComponentsAcrossLoadAndReload(nativeRender);
await testCoexistence(nativeRender);
await testDisabledInstallsNothing(nativeRender);

rmSync(agentDir, { recursive: true, force: true });
console.log("Markdown emphasis tests passed.");

# pi-pretty-tui

[English](./README.md) | 简体中文

为 [Pi coding agent](https://pi.dev/) 打造美观、精致的 TUI 体验。

![pi-pretty-tui 预览](./assets/screenshot.png)

## 功能特性

- 带 `User` 标题的圆角用户消息框，支持主题感知边框、填充背景和 Markdown
- 圆角输入编辑器，保留原生光标、输入法、自动补全和鼠标行为
- 紧凑显示 `Read`、`Bash`、`Edit`、`Write`、`Grep`、`Find` 和 `List` 调用
- 简洁的单工具调用与结果摘要，并支持展开查看详情
- `full` 模式下使用原生风格的 `Write` 预览：折叠时显示前 10 行，展开时显示完整内容
- `full` 模式下实时显示 `Bash` 输出：折叠时显示最新 5 行，展开时显示全部可用输出
- 可切换 `full`、`compact` 和 `clean` 三种渲染模式，并持久化保存设置
- `clean` 模式折叠时隐藏思考块（包括 Pi 独立的 `Thinking...` 占位提示），展开时恢复原始思考内容
- 为编辑统计和 diff 中的 `+added`、`-removed` 提供颜色区分
- 长路径和换行工具输出使用正确的悬挂缩进
- Markdown 无序列表使用圆点（`•`）标记
- 带语言标签和原生语法高亮的圆角代码块
- fullscreen TUI 模式下为围栏代码块提供可点击的 `[Copy]` 控件

## 安装

```sh
pi install npm:pi-pretty-tui
```

安装后重启 Pi，或运行 `/reload`。

Pi 可能会提示内置工具被覆盖。这是正常现象：pi-pretty-tui 会重新注册 Pi 的内置工具，并将实际执行委托给原始实现，只修改它们的 TUI 渲染方式。

## 渲染模式

运行 `/pretty-tui` 可交互选择模式，也可以直接指定：

```text
/pretty-tui full
/pretty-tui compact
/pretty-tui clean
/pretty-tui status
```

- `full`：保留每个工具的详细调用渲染和常规结果预览。按 `Ctrl+O` 可展开可用输出、diff 和内容。
- `compact`：折叠时，所有受支持的内置工具使用简洁的单行调用摘要和最终结果摘要。长命令、写入内容、编辑 diff 和工具输出保持隐藏；按 `Ctrl+O` 可查看完整详情。
- `clean`（默认）：将受支持的工具调用折叠为一个 `Running(...)` 状态；流式工具调用一出现，活动位置就会显示工具名称，例如 `Running(3 tool calls · Read)`，并至少保留 1 秒后才变为 `thinking...`。执行稳定后，标签变为 `Done(...)`。点击分组状态可在保留父级 `Running`/`Done` 行的同时，以缩进的紧凑子项显示该组全部工具；再点击单个工具可切换其完整详情。已送达的 steer 消息、compaction 摘要和可见的 assistant 文本都会开启新的工具组，使后续调用保持 transcript 顺序。折叠时会隐藏思考块，且不显示 Pi 的 `Thinking...` 占位提示；按 `Ctrl+O` 可按照 transcript 顺序显示思考内容以及全部展开的工具调用和输出。

`clean` 模式覆盖本包管理的内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls`。第三方工具保持自己的渲染方式。

所选模式会立即生效，并保存到 `~/.pi/agent/pretty-tui.json`（或 `PI_CODING_AGENT_DIR` 指定目录中的对应位置）。

## 展开工具输出

按 `Ctrl+O`（Pi 默认的 `app.tools.expand` 键位）可以在 `compact` 或 `clean` 模式中显示或隐藏详细输出、编辑 diff、完整 `Write` 内容、完整工具详情和思考内容。在 `clean` 模式下，鼠标还支持渐进式展开：点击分组状态可保留父级并显示紧凑子工具，点击单个子工具可查看其完整视图，再次点击父级可折叠整个分组。

## 复制代码块

在 fullscreen TUI 模式下，Markdown 围栏代码块的顶部边框会显示可点击的 `[Copy]` 控件：

```sh
pi --tui-mode fullscreen
```

点击后只复制代码内容，不包含圆角边框；复制会通过 Pi 原生的 fullscreen 剪贴板路径完成，并显示与直接框选文本相同的临时 `Copied!` 或 `Copy failed` 提示。regular TUI 模式下，终端会保留鼠标输入用于文本选择和滚动，因此该控件会被隐藏。

## 开发

修改渲染状态或 transcript 分组前，请运行仓库内的回归测试：

```sh
npm install
npm test
```

测试覆盖实时与历史恢复时的 steer/compaction 边界、并行工具完成归属、孤立 tool call、重复摘要防护，以及 fullscreen 代码块复制的点击区域。GitHub Actions 会在每次 push 和 pull request 时运行相同检查。

## 兼容性说明

工具渲染使用 Pi 的公开扩展 API。`clean` 模式下的思考与活动工具状态，通过 Pi 导出的交互组件跟随其内置展开和执行状态变化。由于 Pi 目前没有为这些展示细节提供公开渲染钩子，原生用户消息框、原生输入编辑器圆角、无序列表标记和围栏代码块增强需要使用可安全重载的运行时补丁。Markdown 解析、语法高亮和终端语义区域仍由 Pi 处理。

本扩展不会修改 Pi 源文件。运行时补丁会在会话关闭时移除，但未来的 Pi 版本可能需要本扩展同步适配。

## 卸载

```sh
pi remove npm:pi-pretty-tui
```

然后重启 Pi。

## 许可证

MIT

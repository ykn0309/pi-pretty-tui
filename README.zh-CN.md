# pi-pretty-tui

[English](./README.md) | 简体中文

为 [Pi coding agent](https://pi.dev/) 打造美观、精致的 TUI 体验。

## 功能特性

- **可折叠的活动时间线：** 不再让大量独立调用填满对话。工作进行时，所有内置与第三方工具会集中显示为一行 `Running(...)`；工作结束后，则变为低调的 `Done(...)`。父级会统计工具调用和思考数量；展开后，工具与灰色 `● Thinking` 条目会按 transcript 顺序显示，并可分别查看完整详情。
- **按需查看有效信息：** 针对不同工具设计的摘要，会简洁呈现路径、命令、结果、diff、文件预览和实时 shell 输出，同时保留查看原始完整内容的能力。
- **统一、精致的视觉体验：** 圆角用户消息与输入框、主题感知配色、层级清晰的 Markdown 标题、更清爽的列表，以及带语法高亮的圆角代码块，让整个 TUI 更协调。在 fullscreen 模式下，每个围栏代码块还带有符合原生体验的 `[Copy]` 控件。

Pi 内置的 `read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls` 工具使用专门设计的紧凑视图；所有第三方工具会自动获得统一的紧凑行，单独展开时继续使用原生 renderer，但会移除与整体冲突的终端背景色。系统错误、steer 消息、compaction 摘要和可见 assistant 正文保持可见，并形成硬分组边界。同时不会影响 Pi 原有的光标、输入法、自动补全、鼠标交互和工具执行行为。

## 安装

```sh
pi install npm:pi-pretty-tui
```

安装后重启 Pi，或运行 `/reload`。

Pi 可能会提示内置工具被覆盖。这是正常现象：pi-pretty-tui 会重新注册 Pi 的内置工具，并将实际执行委托给原始实现，只修改它们的 TUI 渲染方式。

## 使用工具调用

点击 `Running(...)` 或 `Done(...)` 行，可以保留父级并展开其下方的工具和灰色 `● Thinking` 条目。点击单个工具或思考子项可切换完整视图，再次点击父级可折叠整个分组。任何时候都可以按 `Ctrl+O`，使用 Pi 的全局展开控制来显示或隐藏全部工具输出和思考内容。

活动组执行期间产生的扩展 info 通知会作为无缩进尾注显示在完整分组下方，既保持可见，也不会打断树形工具列表。warning 和 error 仍使用 Pi 原生的即时展示方式。

## 渲染模式

扩展支持三种可持久化的渲染模式：`clean`（默认）、`compact` 和 `full`。运行 `/pretty-tui` 可交互选择，也可以直接使用 `/pretty-tui clean`、`/pretty-tui compact`、`/pretty-tui full` 和 `/pretty-tui status`。所选设置会保存到 `~/.pi/agent/pretty-tui.json`，或 `PI_CODING_AGENT_DIR` 指定目录中的对应位置。

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

测试覆盖实时与历史恢复的活动时间线、system/steer/compaction 边界、内置与第三方工具、可展开思考、并行工具完成归属、孤立 tool call、重复摘要防护，以及 fullscreen 代码块复制的点击区域。GitHub Actions 会在每次 push 和 pull request 时运行相同检查。

## 兼容性说明

工具渲染使用 Pi 的公开扩展 API。思考内容的可见性与活动工具状态，通过 Pi 导出的交互组件跟随其内置展开和执行状态变化。由于 Pi 目前没有为这些展示细节提供公开渲染钩子，原生用户消息框、原生输入编辑器圆角、无序列表标记和围栏代码块增强需要使用可安全重载的运行时补丁。Markdown 解析、语法高亮和终端语义区域仍由 Pi 处理。

本扩展不会修改 Pi 源文件。运行时补丁会在会话关闭时移除，但未来的 Pi 版本可能需要本扩展同步适配。

## 卸载

```sh
pi remove npm:pi-pretty-tui
```

然后重启 Pi。

## 许可证

MIT

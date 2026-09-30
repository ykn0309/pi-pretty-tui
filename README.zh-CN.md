# pi-pretty-tui

[English](./README.md) | 简体中文

为 [Pi coding agent](https://pi.dev/) 打造美观、精致的 TUI 体验。

## 功能特性

- **可折叠的活动时间线：** 不再让大量独立调用填满对话。思考、工具和普通 `info` 通知会进入同一条按真实时间排序的活动流；工作进行时显示为 `Running(...)`，结束后变为低调的 `Done(...)`。父级只统计工具调用和思考数量；展开后可查看所有有序成员，成员摘要在展开嵌套详情后仍然保留。思考与工具地位相同：没有调用任何工具的那一轮同样会有自己的 `Running(1 thought)` / `Done(1 thought)` 父行，思考作为其子级，内容不会被丢弃。
- **可持久化的回答 footer：** 整轮 Agent 工作真正 settled 后（包括工具、自动重试和 compaction），最终回答底部会显示一条低调的灰色分隔线，工作时长与 fullscreen 模式下的 `[Copy]` 控件都嵌在线中。`[Copy]` 只复制最终可见回答，不包含 thought、工具、状态或 footer；reload 和 session tree 切换后仍会保留。
- **实时工作计时：** clean 模式下，耗时显示在输入框顶部边框的 `Working` 右侧，颜色与边框一致。它与完成 footer 共用 Agent 整轮工作的计时起点和时长格式，包含自动重试，工作真正结束后消失；窄输入框放不下时会隐藏计时。展开后的 `Done` 标题和圆点使用主题的 `success` 色，折叠摘要仍保持低调的灰色。
- **临时 UI 状态：** 编辑器上方的一行只显示 Pi 直接产生的 UI 操作反馈，例如 Thinking 或工具输出可见性变化。新状态会替换旧状态，并在十秒后自动消失，不进入 transcript 或 session。
- **按需查看有效信息：** 针对不同工具设计的摘要，会简洁呈现路径、命令、结果、diff、文件预览和实时 shell 输出，同时保留查看原始完整内容的能力。
- **统一、精致的视觉体验：** 透明、右对齐的用户聊天气泡会根据短消息自适应宽度，长消息则在终端宽度的 75% 处换行；气泡使用 accent 浅蓝色圆角边框，并移除了多余的 `User` 标注。配合圆角输入框、主题感知配色、层级清晰的 Markdown 标题、更清爽的列表，以及带语法高亮的圆角代码块，让整个 TUI 更协调。在 fullscreen 模式下，每个围栏代码块还带有符合原生体验的 `[Copy]` 控件。

Pi 内置的 `read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls` 工具使用专门设计的紧凑视图；所有第三方工具会自动获得统一的紧凑行，单独展开时继续使用原生 renderer，但会移除与整体冲突的终端背景色。用户与 steer 消息、compaction 摘要、可见 assistant 正文、warning、error、aborted/length 响应，以及注册了专用 renderer 的 displayed custom message 都会形成硬分组边界。同时不会影响 Pi 原有的光标、输入法、自动补全、鼠标交互和工具执行行为。

## 安装

```sh
pi install npm:pi-pretty-tui
```

安装后重启 Pi，或运行 `/reload`。

Pi 可能会提示内置工具被覆盖。这是正常现象：pi-pretty-tui 会重新注册 Pi 的内置工具，并将实际执行委托给原始实现，只修改它们的 TUI 渲染方式。

## 使用工具调用

点击 `Running(...)` 或 `Done(...)` 行，可以保留父级并展开其下方的工具、已完成的 `● thought` 和扩展更新。点击单个工具或思考子项可在保留摘要的同时展开嵌套详情。每棵展开的树末尾都有 `└─ [↑ Collapse]`，无需滚回父级即可只折叠当前分组；再次点击父级也可以折叠。任何时候都可以按 `Ctrl+O`，使用 Pi 的全局展开控制来显示或隐藏全部工具输出和思考内容；全局展开后，树尾操作仍只折叠本组。第三方替换的 `grep`、`find`（如 FFF）也使用紧凑的树节点，展开子项时仍可查看原生详情。工具名称会原样使用定义中的 `label`，没有 `label` 时回退到原始 `name`；pi-pretty-tui 不再重命名或转换大小写。

扩展调用 `ctx.ui.notify(message, "info")`（或省略 type）时，如果当前已有 thought/tool 活动组，通知会按真实时间顺序加入该组；如果没有现有工作，则独立显示，并且不会附着到未来的工具组。warning 和 error 保持独立，分别使用黄色 `⚠` 和红色 `✕`，并形成硬边界。工具失败继续归属于对应工具详情。上述扩展通知和错误都不会进入临时 UI 状态栏。

没有自有 renderer 的 displayed custom message 使用统一、accent 配色的 `◇` Markdown 显示：当前存在 thought/tool 工作时加入当前组，否则独立显示，并保留 session 持久化。注册了 renderer 的消息完全保留插件原生显示并形成硬边界。所有判断只依据 Pi 的通知 type 和 renderer 是否存在，不识别扩展名称、custom message 名称，也不根据文本内容推断语义。

Pi 内部直接调用 `showStatus()` 产生的反馈属于临时 UI 状态：它只显示在编辑器上方，新状态替换旧状态，并由十秒 timer 自动清除；它不会进入 transcript 或活动时间线，reload 时也会清除。在 clean 模式下，`Ctrl+T` 不修改 Pi 持久化的 Thinking 设置，只显示一条简短提示；thought 详情仅在点击对应子项时展开，`Ctrl+O` 继续负责全局活动展开。在 full 和 compact 模式下，`Ctrl+T` 保留 Pi 的原生行为。

## 设置与渲染模式

运行 `/pretty-tui` 可打开扩展设置。`Enabled` 开关会持久化控制 pi-pretty-tui 是否安装渲染补丁和内置工具 renderer。修改后会自动调用 Pi 官方的 reload 流程，无需手动执行 `/reload`。也可以直接使用 `/pretty-tui enable` 和 `/pretty-tui disable`。禁用期间设置命令仍然可用，Pi 会恢复原生渲染。

扩展支持三种可持久化的渲染模式：`clean`（默认）、`compact` 和 `full`。可交互选择，也可以直接使用 `/pretty-tui clean`、`/pretty-tui compact`、`/pretty-tui full` 和 `/pretty-tui status`。设置会保存到 `~/.pi/agent/pretty-tui.json`，或 `PI_CODING_AGENT_DIR` 指定目录中的对应位置。

## 复制代码块

在 fullscreen TUI 模式下，用户消息与助手回复中的 Markdown 围栏代码块会在顶部边框显示可点击的 `[Copy]` 控件：

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

测试覆盖实时与历史恢复的活动时间线、自动重试与终止状态、用户/steer/compaction/原生 renderer 边界、十秒 UI 状态替换、reload 与 shutdown 时的旧 timer 与状态清理、独立严重级别样式、内置与第三方工具、可展开思考、并行工具完成归属、孤立 tool call、重复摘要防护、可持久化的工作时长与仅回答复制控件、自适应用户聊天气泡、原型补丁的完整恢复，以及 fullscreen 代码块复制的点击区域。GitHub Actions 会在每次 push 和 pull request 时运行相同检查。

## 兼容性说明

工具渲染使用 Pi 的公开扩展 API。活动工具状态通过 Pi 导出的交互组件跟随其内置执行状态变化；clean 模式的 thought 详情使用活动时间线自身的展开状态，full 和 compact 模式则保留 Pi 内置的 Thinking 可见性控制。由于 Pi 目前没有为这些展示细节提供公开渲染钩子，自适应的原生用户消息气泡、原生输入编辑器圆角、无序列表标记和围栏代码块增强需要使用可安全重载的运行时补丁。Markdown 增强仅在渲染主 transcript 中的用户消息和助手回复时启用；扩展 overlay 创建的 Markdown 保持 Pi 原生布局。Markdown 解析、语法高亮和终端语义区域仍由 Pi 处理。

本扩展不会修改 Pi 源文件。运行时补丁会在会话关闭时移除，但未来的 Pi 版本可能需要本扩展同步适配。

## 卸载

```sh
pi remove npm:pi-pretty-tui
```

然后重启 Pi。

## 许可证

MIT

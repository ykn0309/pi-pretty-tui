# Local development

## Tests

```sh
npm install
npm test
```

The suite includes TypeScript checks, transcript regressions, tool coexistence, selection-copy coverage, and Markdown spacing/emphasis checks. The Markdown suites support testing another Pi install through `PI_HOST_MODULE` and `PI_TUI_MODULE`, pointing to the respective packages’ `dist/index.js`. All test settings use temporary agent directories.

## Develop from a local checkout

Pi loads a local package directly from its path, so you can work on a checkout without patching an installed copy. If `npm:pi-pretty-tui` is already in your user settings, create `.pi/settings.json` in the checkout:

```json
{
  "packages": [
    {
      "source": "npm:pi-pretty-tui",
      "autoload": false,
      "extensions": ["-extensions/index.ts"]
    },
    ".."
  ]
}
```

Start from the checkout root with `pi -e .`, then run `/reload` after each source change. `.` in the command is the checkout; `..` in the settings resolves from `.pi/`. Pi treats the npm and local sources as different packages, so the first entry filters the installed copy from the final resource set. Don't commit this file.

On Pi 1.4.0, plain `pi` can still initialize the installed copy during its pre-trust bootstrap, before applying project filters. Its runtime patches can then block local changes even though the final resource list shows only the checkout. Explicit `-e .` loads the checkout early enough to avoid that conflict. Start a new process with that flag if affected; `/reload` alone cannot repair the old process.

- This applies only when the working directory is the checkout root and the project is trusted. From a subdirectory or any other project, Pi keeps using your installed package.
- `pi list` should show `npm:pi-pretty-tui (filtered)` and `..` under project packages.
- Keep `"autoload": false`: without it the entry becomes a separate project package, and Pi installs it into `.pi/npm`. A top-level `extensions` exclusion doesn't work here either, because it doesn't apply to package resources.

## 从本地仓库开发

Pi 会直接从路径加载本地包，因此无需修改已安装的副本即可开发。如果用户设置中已有 `npm:pi-pretty-tui`，请在仓库中创建 `.pi/settings.json`：

```json
{
  "packages": [
    {
      "source": "npm:pi-pretty-tui",
      "autoload": false,
      "extensions": ["-extensions/index.ts"]
    },
    ".."
  ]
}
```

从仓库根目录使用 `pi -e .` 启动，每次修改源码后运行 `/reload`。命令中的 `.` 指仓库目录；`..` 相对于 `.pi/` 解析。Pi 将 npm 来源和本地来源视为不同的包，第一项会从最终资源集合中过滤已安装的副本。请勿提交此文件。

在 Pi 1.4.0 中，直接运行 `pi` 仍可能在项目受信任前的引导阶段初始化已安装的副本，此时项目过滤尚未生效。即使最终资源列表只显示本地仓库，该副本的运行时补丁也可能阻止本地修改生效。显式使用 `-e .` 会更早加载本地仓库，以避免冲突。如果已受影响，请使用该参数启动新进程；仅运行 `/reload` 无法修复旧进程。

- 仅当工作目录是仓库根目录且项目已受信任时生效。在子目录或其他项目中，Pi 仍使用已安装的包。
- `pi list` 的项目包部分应显示 `npm:pi-pretty-tui (filtered)` 和 `..`。
- 请保留 `"autoload": false`：否则该项会成为独立的项目包，Pi 会把它安装到 `.pi/npm`。顶层 `extensions` 排除同样无效，因为它不作用于包内资源。

// Exercise the real Pi resource loader and registered tools, without a model.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const temp = await mkdtemp(join(tmpdir(), "pretty-tui-coexistence-"));
process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
process.env.TMPDIR = temp;
process.env.TMP = temp;
process.env.TEMP = temp;
process.env.PI_OFFLINE = "1";
const host = process.env.PI_HOST_MODULE
  ? pathToFileURL(resolve(process.env.PI_HOST_MODULE)).href
  : "@earendil-works/pi-coding-agent";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(host);

try {
  const prettyDir = join(temp, "pretty");
  await cp(resolve("extensions"), prettyDir, { recursive: true });
  const pretty = join(prettyDir, "index.ts");
  const replacement = join(temp, "replacement.ts");
  await writeFile(replacement, `
    import { Type } from "typebox";
    export default function (pi) {
      pi.registerTool({
        name: "bash", label: "replacement bash", description: "replacement fixture",
        parameters: Type.Object({ command: Type.String(), background: Type.Optional(Type.Boolean()) }),
        renderCall() { return { render: () => ["custom bash renderer"], invalidate() {} }; },
        async execute(_id, args) { return { content: [{ type: "text", text: "replacement:" + args.command }], details: {} }; },
      });
    }
  `);
  const downstream = join(temp, "downstream.ts");
  await writeFile(downstream, `
    export default function (pi) {
      pi.registerToolRenderer((name, next) => name === "read"
        ? { ...next(), renderCall: () => ({ render: () => ["downstream read renderer"], invalidate() {} }) }
        : next());
    }
  `);
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const actual = process.env.PI_BASH_BG_EXTENSION;
  for (const other of [replacement, ...(actual ? [resolve(actual)] : [])]) {
    for (const mode of ["clean", "compact", "full", "disabled"]) {
      await writeFile(join(process.env.PI_CODING_AGENT_DIR, "pretty-tui.json"),
        JSON.stringify(mode === "disabled" ? { enabled: false } : { mode }));
      for (const paths of [[other, pretty, downstream], [pretty, other, downstream]]) {
        const settingsManager = SettingsManager.inMemory();
        const loader = new DefaultResourceLoader({
          cwd: temp, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
          additionalExtensionPaths: paths, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true,
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, [], `extension load failed: ${paths.join(" -> ")}`);
        const { session } = await createAgentSession({
          cwd: temp, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
          resourceLoader: loader, sessionManager: SessionManager.inMemory(),
        });
        try {
          await session.bindExtensions({});
          const tools = session.agent.state.tools;
          const bash = tools.find((tool) => tool.name === "bash");
          assert.ok(bash);
          const readRenderer = session.extensionRunner.resolveToolRenderers("read", () => session.getToolDefinition("read"));
          const renderedRead = readRenderer.renderCall(
            { path: "sample.txt" }, { fg: (_color, text) => text, bold: (text) => text },
            { toolCallId: "read-fixture", expanded: true, executionStarted: true, state: {} },
          ).render(80).join("\n");
          if (mode === "clean") assert.match(renderedRead, /sample\.txt/);
          else assert.match(renderedRead, /downstream read renderer/);
          if (other === replacement) {
            assert.equal(bash.parameters.properties.background.type, "boolean");
            const renderer = session.extensionRunner.resolveToolRenderers("bash", () => session.getToolDefinition("bash"));
            assert.deepEqual(renderer.renderCall({}, {}, {}).render(), ["custom bash renderer"]);
            const result = await bash.execute("fixture", { command: "hello", background: true });
            assert.equal(result.content[0].text, "replacement:hello");
          } else {
            assert.ok(tools.find((tool) => tool.name === "bg_join"));
            const command = process.platform === "win32"
              ? "Write-Output 'pretty-bg-foreground'"
              : "printf 'pretty-bg-foreground\\n'";
            const foreground = await bash.execute("foreground", { command, timeout: 20 });
            assert.match(foreground.content[0].text, /pretty-bg-foreground/);
            await assert.rejects(bash.execute("failure", { command: "exit 7", timeout: 20 }), /exited with code 7/);
            const slow = process.platform === "win32"
              ? "Start-Sleep -Seconds 2; Write-Output 'pretty-bg-background'"
              : "sleep 2; printf 'pretty-bg-background\\n'";
            const started = await bash.execute("background", { command: slow, timeout: 0.1 });
            const taskId = /taskId:\s*([^\s]+)/.exec(started.content[0].text)?.[1];
            assert.ok(taskId, started.content[0].text);
            const joined = await tools.find((tool) => tool.name === "bg_join")
              .execute("join", { taskId, timeoutSeconds: 15 });
            assert.match(joined.content[0].text, /pretty-bg-background/);
            const status = await tools.find((tool) => tool.name === "bg_status")
              .execute("status", { taskId });
            assert.match(status.content[0].text, /status:\s*done/);
            const logs = await tools.find((tool) => tool.name === "bg_logs")
              .execute("logs", { taskId });
            assert.match(logs.content[0].text, /pretty-bg-background/);
          }
          await session.reload();
          assert.deepEqual(loader.getExtensions().errors, [], "extension reload failed");
          const reloadedBash = session.agent.state.tools.find((tool) => tool.name === "bash");
          assert.ok(reloadedBash);
          const afterReload = await reloadedBash.execute("after-reload", {
            command: other === replacement ? "again" : process.platform === "win32"
              ? "Write-Output 'after-reload'" : "printf 'after-reload\\n'",
            timeout: 20,
          });
          assert.match(afterReload.content[0].text, other === replacement ? /replacement:again/ : /after-reload/);
        } finally {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        }
      }
    }
  }
  console.log("Real Pi extension coexistence passed" + (actual ? " (including pi-bash-bg)." : "."));
} finally {
  await rm(temp, { recursive: true, force: true });
}

"""Native PTY smoke test: real terminal input/output and SGR mouse bytes."""
import shutil
import os, pty, fcntl, termios, struct, subprocess, tempfile, json, select, time, signal
from pathlib import Path
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="pretty-selection-pty-") as scratch:
    ready, result = Path(scratch)/"ready.json", Path(scratch)/"copy.json"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 25, 100, 0, 0))
    env = dict(os.environ, PRETTY_SELECTION_READY=str(ready), PRETTY_SELECTION_RESULT=str(result), TERM="xterm-256color", PI_CODING_AGENT_DIR=scratch, PI_OFFLINE="1")
    (Path(scratch)/"settings.json").write_text(json.dumps({"tuiMode":"fullscreen","fullscreenCopyOnSelect":True,"fullscreenExitOutput":"resume-hint"}))
    (Path(scratch)/"pretty-tui.json").write_text(json.dumps({"selectionCopy":True}))
    fixture=subprocess.check_output(["node", "tests/selection-cli-fixture.mjs", scratch], cwd=root, env=env, text=True).strip()
    cmd=[shutil.which("pi"),"--no-extensions","--no-skills","--no-prompt-templates","--no-themes",
         "--model","selection-fixture/offline","--session",fixture,
         "-e",str(root/"extensions/index.ts"),"-e",str(root/"tests/selection-cli-probe.ts")]
    proc = subprocess.Popen(cmd, cwd=scratch, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    captured = bytearray()
    def until(predicate, timeout=25):
        end = time.monotonic()+timeout
        while time.monotonic()<end:
            if predicate(): return
            if proc.poll() is not None: raise RuntimeError(captured.decode(errors="replace"))
            readable, _, _ = select.select([master], [], [], .05)
            if readable:
                try: captured.extend(os.read(master, 65536))
                except OSError: pass
        raise TimeoutError(captured.decode(errors="replace")[-3000:])
    def state():
        try: return json.loads(ready.read_text())
        except (FileNotFoundError, json.JSONDecodeError): return {}
    def gesture(start, end):
        result.unlink(missing_ok=True)
        for button, (row,col), release in [(0,start,False),(32,end,False),(0,end,True)]:
            os.write(master, f"\x1b[<{button};{col+1};{row+1}{'m' if release else 'M'}".encode())
        until(lambda: result.exists())
        return json.loads(result.read_text())["text"]
    try:
        until(lambda: any("const divider" in line for line in state().get("lines",[])))
        lines=state()["lines"]
        row=next(i for i,line in enumerate(lines) if "const divider" in line)
        got=gesture((row-1,0),(row+4,99))
        assert got=='  const divider = "│";\n\n├─ real tree\nx ─ y', repr(got)
        lines=state()["lines"]
        first=next(i for i,line in enumerate(lines) if line.startswith("│first"))
        got=gesture((first,1),(first+2,8))
        assert got=='first\n  second\n│ third', repr(got)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH",25,60,0,0));proc.send_signal(signal.SIGWINCH)
        until(lambda: state().get("columns")==60)
        lines=state()["lines"]
        row=next(i for i,line in enumerate(lines) if "const divider" in line)
        got=gesture((row-1,0),(row+4,59))
        assert got=='  const divider = "│";\n\n├─ real tree\nx ─ y', repr(got)
        assert b"ppt-select-" not in captured, "private metadata leaked to terminal"
        print("Real Pi CLI selection passed: opaque user bubble, composer, real SGR mouse, resize, literal glyphs, terminal hygiene.")
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        os.close(master)

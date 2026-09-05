import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree rejects system, negative and non-integer process IDs", () => {
  for (const pid of [0, 1, -1, -1234, 1.5, Number.NaN]) {
    const outcome = terminateProcessTree(pid, {
      runCommandImpl() { throw new Error("Must not inspect processes"); },
      killImpl() { throw new Error("Must not signal processes"); }
    });
    assert.equal(outcome.attempted, false);
  }
});

test("POSIX cancellation includes detached descendants and falls back to individual processes", () => {
  const signalled = [];
  const outcome = terminateProcessTree(100, {
    platform: "darwin",
    runCommandImpl(command, args, options) {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-A", "-o", "pid=,ppid="]);
      assert.equal(options.shell, false);
      return { status: 0, stdout: "100 1\n200 100\n300 200\n400 1\n", stderr: "", error: null };
    },
    killImpl(pid, signal) {
      assert.equal(signal, "SIGTERM");
      signalled.push(pid);
      if (pid === -200) throw Object.assign(new Error("Not a group leader"), { code: "ESRCH" });
    }
  });
  assert.deepEqual(signalled, [-300, -200, 200, -100]);
  assert.deepEqual(outcome.descendantPids, [300, 200]);
  assert.equal(outcome.method, "process-tree");
});

test("POSIX cancellation fails visibly when process discovery fails", () => {
  assert.throws(() => terminateProcessTree(100, {
    platform: "linux",
    runCommandImpl: () => ({ status: 1, stdout: "", stderr: "process discovery denied", error: null }),
    killImpl() { throw new Error("Must not signal an uninspected tree"); }
  }), /process discovery denied/);
});

test("POSIX cancellation stops a real child in a separate process group", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const source = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
    process.stdout.write(String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let childPid;
  const isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try {
    const [data] = await once(parent.stdout, "data");
    childPid = Number(data.toString());
    assert.ok(childPid > 0);
    const outcome = terminateProcessTree(parent.pid);
    assert.ok(outcome.descendantPids.includes(childPid));
    for (let i = 0; i < 50 && (isAlive(childPid) || isAlive(parent.pid)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isAlive(parent.pid), false);
    assert.equal(isAlive(childPid), false);
  } finally {
    for (const pid of [childPid, parent.pid]) {
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }
});

import { spawn } from "node:child_process";

import { createOpenCodeEventCollector } from "./opencode-events.mjs";

const MAX_DIAGNOSTIC_CHARS = 16 * 1024;

export function runOpenCodeProcess(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdoutBuffer = "";
    let stderr = "";
    let inputError = null;
    const collector = createOpenCodeEventCollector({
      onProgress: options.onProgress,
      threadId: options.threadId
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) collector.consumeLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_CHARS);
    });
    child.stdin.on("error", (error) => { inputError = error; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      collector.consumeLine(stdoutBuffer);
      resolve({
        code: code ?? 1,
        signal,
        stderr: stderr.trim(),
        inputError,
        ...collector.result()
      });
    });
    // OpenCode reads non-interactive stdin. Prompts must not become CLI flags or
    // exceed the platform's argument-size limit when a review includes a diff.
    child.stdin.end(options.prompt, "utf8");
  });
}

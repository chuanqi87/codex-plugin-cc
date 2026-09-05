function findDescendants(pid, processTable) {
  const children = new Map();
  for (const line of processTable.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const visited = new Set([pid]);
  const descendants = [];
  for (const parent of visited) {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      descendants.push(child);
    }
  }
  return descendants.reverse();
}

function signalProcess(pid, killImpl) {
  try {
    killImpl(-pid, "SIGTERM");
    return { delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  // A live process need not lead its own process group.
  try {
    killImpl(pid, "SIGTERM");
    return { delivered: true, method: "process" };
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return { delivered: false, method: "process" };
  }
}

export function terminatePosixProcessTree(pid, options) {
  const result = options.runCommandImpl("ps", ["-A", "-o", "pid=,ppid="], {
    cwd: options.cwd,
    env: options.env,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect the process tree before cancellation: ${result.stderr.trim() || `ps exited with status ${result.status}`}`);
  }
  // OpenCode tools may start new process groups. Snapshot descendants before
  // stopping the worker, otherwise detached tools are reparented and escape it.
  const descendantPids = findDescendants(pid, result.stdout);
  let delivered = false;
  for (const childPid of descendantPids) {
    delivered = signalProcess(childPid, options.killImpl).delivered || delivered;
  }
  const root = signalProcess(pid, options.killImpl);
  return {
    attempted: true,
    delivered: delivered || root.delivered,
    method: descendantPids.length ? "process-tree" : root.method,
    descendantPids
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  listBackendAdapters,
  resolveBackendAdapter
} from "../plugins/codex/scripts/lib/backend-adapters.mjs";
import { resolveBridgeContext } from "../plugins/codex/scripts/lib/bridge-context.mjs";
import {
  listHostAdapters,
  resolveHostAdapter
} from "../plugins/codex/scripts/lib/host-adapters.mjs";

test("adapter registries expose only implemented hosts and backends", () => {
  assert.deepEqual(
    listHostAdapters().map((host) => host.id),
    ["claude-code"]
  );
  assert.deepEqual(
    listBackendAdapters().map((backend) => backend.id),
    ["codex", "opencode"]
  );
  assert.equal(resolveHostAdapter().capabilities.sessionExport, true);
  const backend = resolveBackendAdapter();
  assert.equal(backend.capabilities.task, true);
  assert.equal(backend.normalizeModel("spark"), "gpt-5.3-codex-spark");
  assert.equal(backend.normalizeReasoningEffort("HIGH"), "high");

  const openCode = resolveBackendAdapter("opencode");
  assert.equal(openCode.capabilities.task, true);
  assert.equal(openCode.capabilities.review, true);
  assert.equal(openCode.capabilities.sessionImport, false);
  assert.equal(openCode.normalizeModel("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  assert.equal(openCode.normalizeReasoningEffort("high"), "high");
});

test("bridge context resolves explicit and environment-selected adapters", () => {
  const explicit = resolveBridgeContext(
    { host: "claude-code", backend: "codex" },
    { AGENT_BRIDGE_SESSION_ID: "session-explicit" }
  );
  assert.equal(explicit.hostId, "claude-code");
  assert.equal(explicit.backendId, "codex");
  assert.equal(explicit.sessionId, "session-explicit");

  const fromEnvironment = resolveBridgeContext(
    {},
    {
      AGENT_BRIDGE_HOST: "claude-code",
      AGENT_BRIDGE_BACKEND: "codex",
      CODEX_COMPANION_SESSION_ID: "session-legacy"
    }
  );
  assert.equal(fromEnvironment.sessionId, "session-legacy");
});

test("adapter registries reject unimplemented integrations instead of silently falling back", () => {
  assert.throws(() => resolveHostAdapter("qoder"), /Unsupported host adapter "qoder".*claude-code/);
  assert.throws(() => resolveBackendAdapter("qoder"), /Unsupported agent backend "qoder".*codex, opencode/);
});

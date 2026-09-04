import process from "node:process";

import { resolveBackendAdapter } from "./backend-adapters.mjs";
import { resolveHostAdapter } from "./host-adapters.mjs";

export function resolveBridgeContext(options = {}, env = process.env) {
  const host = resolveHostAdapter(options.host, env);
  const backend = resolveBackendAdapter(options.backend, env);
  return {
    host,
    backend,
    hostId: host.id,
    backendId: backend.id,
    sessionId: host.getSessionId(env)
  };
}

export function assertBridgeCapability(context, capability) {
  if (!context.backend.capabilities[capability]) {
    throw new Error(
      `${context.backend.displayName} does not support the ${capability} capability required by ${context.host.displayName}.`
    );
  }
}

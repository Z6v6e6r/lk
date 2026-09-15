#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = new Set(["cup", "provider", "identity"]);
const LISTENERS = Object.freeze({
  cup: "127.0.0.1:3037",
  provider: "127.0.0.1:3038",
  identity: "127.0.0.1:3039",
});
const AUTHORIZATION_MARKER = "/srv/lk1-subscription-dev/authorization/service-start.approved";

export function validateLockedFixtureRuntime(argv, exists = fs.existsSync) {
  if (argv.length === 1 && argv[0] === "--self-check") {
    return { mode: "SELF_CHECK", roles: [...ROLES], listeners: LISTENERS };
  }
  if (argv.length !== 2 || argv[0] !== "--role" || !ROLES.has(argv[1])) {
    throw new Error("Usage: locked_fixture_runtime.mjs --self-check | --role cup|provider|identity");
  }
  if (!exists(AUTHORIZATION_MARKER)) {
    const error = new Error("SERVICE_START_AUTHORIZATION_ABSENT");
    error.code = "SERVICE_START_AUTHORIZATION_ABSENT";
    throw error;
  }
  throw new Error("BOOTSTRAP_RUNTIME_HAS_NO_ACTIVATABLE_IMPLEMENTATION");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = validateLockedFixtureRuntime(process.argv.slice(2));
    if (result.mode === "SELF_CHECK") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.code || "BOOTSTRAP_RUNTIME_BLOCKED"}\n`);
    process.exitCode = 78;
  }
}

export const fixtureRuntimeIdentity = Object.freeze({
  root: path.dirname(fileURLToPath(import.meta.url)),
  authorizationMarker: AUTHORIZATION_MARKER,
  listeners: LISTENERS,
});

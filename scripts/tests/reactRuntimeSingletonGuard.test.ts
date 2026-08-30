import assert from "node:assert/strict";
import test from "node:test";
import { assertSingleReactRuntime } from "../react_runtime_singleton_guard.ts";

const marker = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";

test("accepts the expected single React runtime marker set", () => {
  assert.doesNotThrow(() => assertSingleReactRuntime(marker.repeat(3), "bundle-dev.js"));
});

test("rejects a root bundle containing a second React runtime", () => {
  assert.throws(
    () => assertSingleReactRuntime(marker.repeat(4), "bundle-dev.js"),
    /contains duplicate React runtimes/,
  );
});

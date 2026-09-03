import assert from "node:assert/strict";
import test from "node:test";
import {
  RequestTimeoutError,
  runWithAbortTimeout,
} from "../../src/utils/requestTimeout.ts";

test("subscription transport timeout aborts a stuck request and releases the caller", async () => {
  let aborted = false;
  await assert.rejects(
    runWithAbortTimeout(15, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return new Promise<never>(() => undefined);
    }),
    (error: unknown) => error instanceof RequestTimeoutError
      && error.code === "REQUEST_TIMEOUT"
      && error.timeoutMs === 15,
  );
  assert.equal(aborted, true);
});

test("completed subscription requests are not aborted", async () => {
  let signal: AbortSignal | null = null;
  const value = await runWithAbortTimeout(100, async (requestSignal) => {
    signal = requestSignal;
    return "confirmed";
  });
  assert.equal(value, "confirmed");
  assert.equal(signal?.aborted, false);
});

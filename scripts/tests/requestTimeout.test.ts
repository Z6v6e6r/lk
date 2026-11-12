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

test("owner cancellation aborts the read and releases a caller even if the read ignores abort", async () => {
  const owner = new AbortController();
  let readSignal: AbortSignal | undefined;
  const pending = runWithAbortTimeout(1000, async (signal) => {
    readSignal = signal;
    return new Promise<never>(() => undefined);
  }, owner.signal);
  owner.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(readSignal?.aborted, true);
});

test("an already cancelled owner never starts a read", async () => {
  const owner = new AbortController();
  owner.abort();
  let calls = 0;
  await assert.rejects(runWithAbortTimeout(1000, async () => ++calls, owner.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("completed requests detach owner cancellation", async () => {
  const owner = new AbortController();
  let readSignal: AbortSignal | undefined;
  await runWithAbortTimeout(1000, async (signal) => {
    readSignal = signal;
    return "done";
  }, owner.signal);
  owner.abort();
  assert.equal(readSignal?.aborted, false);
});

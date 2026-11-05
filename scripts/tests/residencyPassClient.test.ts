import assert from "node:assert/strict";
import test from "node:test";

import { createResidencyPassClient } from "../../src/residency/residencyPassClient.ts";
import type { ResidencyTransport, ResidencyTransportResult } from "../../src/residency/residencyPassClient.ts";

const PASS_ID = "resident_pass:3f1c5c6e-1f2a-4b3c-8d9e-0a1b2c3d4e5f";
const TOKEN = "rsp1_abcdefghijklmnopqrstuvwxyz012345";
const SUBSCRIPTION_ID = "8f14e45f-ceea-4a67-a1f7-2b1c3d4e5f60";

function passPayload() {
  return {
    schemaVersion: 1,
    passId: PASS_ID,
    passToken: TOKEN,
    issuedAt: "2026-11-05T12:00:00.000Z",
    expiresAt: "2026-11-05T12:01:30.000Z",
    subscriptionInstanceId: "subscription_instance:5f1c5c6e-1f2a-4b3c-8d9e-0a1b2c3d4e5f",
    residency: {
      subscriptionTypeId: "type-1",
      subscriptionTypeTitle: "Резидент",
      activeFrom: "2026-01-01T00:00:00.000Z",
      activeTo: "2027-01-01T00:00:00.000Z",
    },
  };
}

function transportWith(results: ResidencyTransportResult[], calls: unknown[] = []): ResidencyTransport {
  let index = 0;
  return async (request) => {
    calls.push(request);
    const next = results[Math.min(index, results.length - 1)];
    index += 1;
    return next;
  };
}

function ok(data: unknown): ResidencyTransportResult {
  return { status: 200, data, networkError: false };
}

function failure(status: number, code: string): ResidencyTransportResult {
  return { status, data: { code, message: "server message" }, networkError: false };
}

test("creates a pass with the exact gateway contract and never retries the POST", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = createResidencyPassClient(transportWith([ok(passPayload())], calls));
  const result = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/lk/residency/passes");
  assert.deepEqual(calls[0].body, { clientSubscriptionId: SUBSCRIPTION_ID });
  if (result.ok) {
    assert.equal(result.value.passToken, TOKEN);
    assert.equal(result.value.residency.subscriptionTypeTitle, "Резидент");
  }
});

test("surfaces stable gateway codes instead of raw upstream text", async () => {
  const client = createResidencyPassClient(transportWith([
    failure(409, "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN"),
    failure(503, "RESIDENT_EVIDENCE_STALE"),
    failure(404, "RESIDENT_PASS_NOT_FOUND"),
    { status: 500, data: null, networkError: false },
  ]));
  const frozen = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(frozen.ok, false);
  if (!frozen.ok) {
    assert.equal(frozen.failure.code, "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN");
    assert.equal(frozen.failure.status, 409);
    assert.equal(frozen.failure.networkError, false);
  }
  const stale = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.failure.code, "RESIDENT_EVIDENCE_STALE");
  const notFound = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.failure.code, "RESIDENT_PASS_NOT_FOUND");
  const serverError = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(serverError.ok, false);
  if (!serverError.ok) assert.equal(serverError.failure.code, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE");
});

test("a network failure never looks like an issued pass", async () => {
  const client = createResidencyPassClient(transportWith([{ status: null, data: null, networkError: true }]));
  const result = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.networkError, true);
    assert.equal(result.failure.code, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE");
  }
});

test("rejects a malformed pass instead of drawing an unverifiable QR", async () => {
  const client = createResidencyPassClient(transportWith([ok({ ...passPayload(), passToken: "short" })]));
  const result = await client.createPass(SUBSCRIPTION_ID);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.code, "RESIDENT_CLIENT_UPSTREAM_INVALID");
});

test("reads the optional pass status for post-issue confirmation", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const client = createResidencyPassClient(transportWith([ok({
    schemaVersion: 1,
    statusAvailable: true,
    state: "CONSUMED",
    issuedAt: "2026-11-05T12:00:00.000Z",
    expiresAt: "2026-11-05T12:01:30.000Z",
    consumedAt: "2026-11-05T12:00:40.000Z",
  })], calls));
  const result = await client.fetchStatus(PASS_ID);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.state, "CONSUMED");
    assert.equal(result.value.consumedAt, "2026-11-05T12:00:40.000Z");
  }
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/lk/residency/passes/" + encodeURIComponent(PASS_ID));
});

test("degraded status responses stay explicit", async () => {
  const client = createResidencyPassClient(transportWith([ok({
    schemaVersion: 1,
    statusAvailable: false,
    state: "UNKNOWN",
    issuedAt: null,
    expiresAt: null,
    consumedAt: null,
  })]));
  const result = await client.fetchStatus(PASS_ID);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.statusAvailable, false);

  const missing = createResidencyPassClient(transportWith([failure(404, "RESIDENT_PASS_NOT_FOUND")]));
  const missingResult = await missing.fetchStatus(PASS_ID);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.equal(missingResult.failure.status, 404);
});

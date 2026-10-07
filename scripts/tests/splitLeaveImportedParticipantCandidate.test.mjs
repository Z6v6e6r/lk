import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  DEPLOYMENT_ID,
  PATCHED_BLOCK,
  ROUTER_NODE,
  buildCandidate,
  patchRouterBody,
} from "../prepare_split_leave_imported_participant_candidate.mjs";

const FIXTURE_PATH = "scripts/tests/fixtures/splitLeaveRouterLive20260915.node.json";
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// Read-only capture of the deployed node `9878400d518ebcbd` taken from
// lk-primary-147 on 2026-09-15. The patcher refuses to run against anything else.
test("captured live router fixture matches the reviewed deployment preimage", () => {
  assert.equal(fixture.id, ROUTER_NODE.id);
  assert.equal(fixture.type, "function");
  assert.equal(sha256(fixture.func), ROUTER_NODE.liveSha256);
});

test("reviewed patch is surgical and compiles", () => {
  const patched = patchRouterBody(fixture.func);
  assert.notEqual(sha256(patched), ROUTER_NODE.liveSha256);
  assert.equal(
    patched.split(PATCHED_BLOCK.trim()).length - 1 >= 1,
    true,
  );
  // Everything before and after the patched block stays byte-identical.
  const prefixLength = fixture.func.indexOf("\n    ctx.preCancelVerification = false;");
  assert.ok(prefixLength > 0);
  assert.equal(patched.slice(0, prefixLength), fixture.func.slice(0, prefixLength));
  assert.equal(patched.slice(patched.length - 200), fixture.func.slice(fixture.func.length - 200));
  assert.equal(patched.includes("Не удалось зафиксировать поколение записи"), true);
  assert.equal(patched.includes('"RETRY_REQUIRED", "Не удалось подтвердить отмену записи Viva'), true);
});

test("the patched production body lets an imported participant leave", () => {
  const patchedBody = patchRouterBody(fixture.func);
  const call = (msg, ctxValues = {}) => new Function("msg", "global", "flow", patchedBody)(
    msg,
    { get: () => undefined, set: () => undefined },
    { get: (key) => ctxValues[key], set: (key, value) => { ctxValues[key] = value; } },
  );

  // The reported game: participant present in the LK roster, no booking of their
  // own anywhere in the record, and no live booking for the exercise in Viva.
  const ctx = {
    gameId: "pay_5a974d14-0b71-45d0-816c-3541de378532",
    operationId: "self-leave:pay_5a974d14:83756527",
    claimToken: "claim-1",
    mode: "SELF",
    actorClientId: "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
    actorPhoneNorm: "79104303190",
    targetClientId: "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
    targetPhoneNorm: "79104303190",
    exerciseId: "364a1579-0500-43d8-a45d-17e1a4dafd7a",
    initialBookingIds: [],
    bookingQueue: [],
    bookingResults: [],
    trace: [],
    step: "verify_history",
    localOnlyNoBooking: true,
    preOperationDiscovery: true,
    preCancelVerification: false,
    membershipVersion: null,
    game: {
      updatedAt: "2026-09-15T12:32:04.167Z",
      metadata: {
        splitPayment: {
          payments: [{
            role: "ORGANIZER",
            status: "PAID",
            clientId: "191ff3d9-52d3-4182-8ad9-46ff7e4e4339",
            bookingId: "aeb23cc9-b20f-4d84-aed9-69431fa3111f",
          }],
        },
      },
      participants: [
        { id: "191ff3d9-52d3-4182-8ad9-46ff7e4e4339", source: "ORGANIZER" },
        { id: "83756527-cfbe-4b7f-b143-1a6ac96d2a93", source: "ADMIN" },
      ],
    },
  };

  const out = call({
    _splitLeaveCtx: ctx,
    statusCode: 200,
    payload: {
      content: [{
        id: "230c8a7b-b6a2-4a00-b0da-36e3f866847d",
        clientId: "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
        exerciseId: "364a1579-0500-43d8-a45d-17e1a4dafd7a",
        isCancelled: true,
        cancellationDate: "2026-09-15T11:00:00Z",
      }],
      last: true,
    },
  });
  assert.equal(out[1], null, `expected a durable operation, got ${out[1]?.statusCode} ${out[1]?.payload?.message}`);
  const operation = out[4];
  assert.ok(operation, "expected the durable operation branch");
  assert.equal(operation._splitLeaveCtx.vivaTargetMode, "NONE");
  assert.equal(operation._splitLeaveCtx.vivaVerification, "no_active_booking_for_exercise");
  assert.match(String(operation._splitLeaveCtx.membershipVersion || ""), /^[a-z0-9]+$/);
  assert.equal(
    operation._splitLeaveCtx.operationId,
    `self-leave:${ctx.gameId}:${ctx.targetClientId}:${operation._splitLeaveCtx.membershipVersion}`,
  );
});

test("a payment row of the leaving player keeps failing closed as retryable", () => {
  const patchedBody = patchRouterBody(fixture.func);
  const ctx = {
    gameId: "game-1",
    mode: "SELF",
    targetClientId: "client-1",
    targetPhoneNorm: "79990000001",
    exerciseId: "exercise-1",
    initialBookingIds: [],
    bookingQueue: [],
    bookingResults: [],
    trace: [],
    step: "verify_history",
    localOnlyNoBooking: true,
    membershipVersion: null,
    game: {
      updatedAt: "2026-08-01T09:00:00.000Z",
      metadata: { splitPayment: { payments: [{ clientId: "client-1", bookingId: "booking-1", status: "PAID" }] } },
      participants: [{ id: "client-1" }],
    },
  };
  const out = new Function("msg", "global", "flow", patchedBody)(
    { _splitLeaveCtx: ctx, statusCode: 200, payload: { content: [], last: true } },
    { get: () => undefined, set: () => undefined },
    { get: () => undefined, set: () => undefined },
  );
  assert.equal(out[4], null);
  assert.equal(out[1].statusCode, 202);
  assert.equal(out[1].payload.state, "RETRY_REQUIRED");
});

test("candidate composition keeps a single reviewed function change", () => {
  const liveFlow = [fixture, {
    id: "http-in-1",
    type: "http in",
    url: "/lk/games/:gameId/split/leave",
    method: "post",
    wires: [[fixture.id]],
  }];
  const liveBytes = Buffer.from(JSON.stringify(liveFlow, null, 2) + "\n");
  const result = buildCandidate(liveBytes);
  assert.equal(result.contract.deploymentId, DEPLOYMENT_ID);
  assert.equal(result.contract.allowedChanges.length, 1);
  assert.equal(result.contract.allowedChanges[0].id, ROUTER_NODE.id);
  assert.deepEqual(result.contract.allowedChanges[0].fields, ["func"]);
  assert.equal(result.contract.allowedChanges[0].sourceFuncSha256, ROUTER_NODE.liveSha256);
  assert.equal(result.contract.allowedChanges[0].candidateFuncSha256, sha256(patchRouterBody(fixture.func)));
  const candidate = JSON.parse(result.candidateBytes.toString("utf8"));
  assert.equal(candidate.length, liveFlow.length);
  assert.equal(
    candidate.find((node) => node.id !== ROUTER_NODE.id).type,
    "http in",
  );
  assert.equal(buildCandidate(liveBytes).candidateBytes.equals(result.candidateBytes), true);
});

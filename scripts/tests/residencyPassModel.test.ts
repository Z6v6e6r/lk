import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_AUTO_RENEWALS_WITH_STATUS,
  MAX_AUTO_RENEWALS_WITHOUT_STATUS,
  buildResidentPassQrValue,
  computeServerOffsetMs,
  formatCountdown,
  isPassUsable,
  isProbeableFailure,
  isResidentPassPayload,
  isResidentPassStatusPayload,
  mapFailureToState,
  passRemainingMs,
  resolveActiveCandidates,
  shouldAutoRenew,
  type ResidentPass,
} from "../../src/residency/residencyPassModel.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const TOKEN = "rsp1_abcdefghijklmnopqrstuvwxyz012345";

function subscription(overrides: Record<string, unknown>) {
  return {
    subscriptionId: "8f14e45f-ceea-4a67-a1f7-2b1c3d4e5f60",
    name: "Абонемент",
    status: "ACTIVE",
    activationDate: "2026-01-01T00:00:00.000Z",
    expirationDate: "2027-01-01T00:00:00.000Z",
    holdUntil: null,
    ...overrides,
  } as never;
}

function pass(overrides: Partial<ResidentPass> = {}): ResidentPass {
  return {
    schemaVersion: 1,
    passId: "resident_pass:3f1c5c6e-1f2a-4b3c-8d9e-0a1b2c3d4e5f",
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
    ...overrides,
  };
}

test("active candidates exclude expired, frozen and future subscriptions", () => {
  const result = resolveActiveCandidates([
    subscription({ subscriptionId: "a", status: "ACTIVE" }),
    subscription({ subscriptionId: "b", status: "ACTIVE", expirationDate: "2020-01-01T00:00:00.000Z" }),
    subscription({ subscriptionId: "c", status: "ACTIVE", holdUntil: "2027-01-01T00:00:00.000Z" }),
    subscription({ subscriptionId: "d", status: "ACTIVE", activationDate: "2027-02-01T00:00:00.000Z" }),
    subscription({ subscriptionId: "e", status: "CANCELLED" }),
  ] as never, NOW);
  assert.deepEqual(result.candidates.map((candidate) => candidate.clientSubscriptionId), ["a"]);
  assert.equal(result.frozen?.holdUntil, "2027-01-01T00:00:00.000Z");
});

test("resident-looking names are probed first, then the longest term", () => {
  const result = resolveActiveCandidates([
    subscription({ subscriptionId: "plain", name: "Разовый", expirationDate: "2028-01-01T00:00:00.000Z" }),
    subscription({ subscriptionId: "resident", name: "Резидент года", expirationDate: "2027-01-01T00:00:00.000Z" }),
    subscription({ subscriptionId: "other", name: "Тренировки", expirationDate: "2026-12-01T00:00:00.000Z" }),
    subscription({ subscriptionId: "fourth", name: "Ещё", expirationDate: "2026-11-20T00:00:00.000Z" }),
  ] as never, NOW);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.clientSubscriptionId),
    ["resident", "plain", "other"],
  );
});

test("unknown subscription data is reported as unavailable, not empty", () => {
  assert.equal(resolveActiveCandidates(null, NOW).unavailable, true);
  assert.equal(resolveActiveCandidates([], NOW).unavailable, false);
  assert.deepEqual(resolveActiveCandidates([], NOW).candidates, []);
});

test("only not-resident failures fall through to the next candidate", () => {
  for (const code of [
    "RESIDENT_CLIENT_SUBSCRIPTION_INVALID",
    "RESIDENT_PASS_NOT_FOUND",
    "RESIDENT_NOT_ACTIVE",
    "RESIDENT_TERM_EXPIRED",
  ]) {
    assert.equal(isProbeableFailure(code), true, code);
  }
  for (const code of [
    "RESIDENT_EVIDENCE_STALE",
    "RESIDENT_CLIENT_AUTH_REQUIRED",
    "RESIDENT_CLIENT_RATE_LIMITED",
    "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE",
    "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN",
  ]) {
    assert.equal(isProbeableFailure(code), false, code);
  }
});

test("failures map to separate visible states", () => {
  assert.equal(mapFailureToState({ code: "X", status: null, networkError: true }).kind, "offline");
  assert.equal(mapFailureToState({ code: "RESIDENT_CLIENT_AUTH_REQUIRED", status: 401, networkError: false }).kind, "session_expired");
  assert.equal(mapFailureToState({ code: "RESIDENT_CLIENT_RATE_LIMITED", status: 429, networkError: false }).kind, "rate_limited");
  assert.equal(mapFailureToState({ code: "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN", status: 409, networkError: false }).kind, "frozen");
  assert.equal(mapFailureToState({ code: "RESIDENT_TERM_EXPIRED", status: 409, networkError: false }).kind, "term_expired");
  assert.equal(mapFailureToState({ code: "RESIDENT_PASS_NOT_FOUND", status: 404, networkError: false }).kind, "not_resident");
  assert.equal(mapFailureToState({ code: "RESIDENT_NOT_ACTIVE", status: 403, networkError: false }).kind, "not_resident");
  const unavailable = mapFailureToState({ code: "RESIDENT_EVIDENCE_STALE", status: 503, networkError: false });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(mapFailureToState({ code: "SOMETHING", status: 503, networkError: false }).kind, "unavailable");
  assert.equal(mapFailureToState({ code: "RESIDENT_CLIENT_FORBIDDEN", status: 403, networkError: false }).kind, "error");
});

test("countdown uses the server clock, not the device clock", () => {
  const receivedAt = NOW + 5000;
  const offset = computeServerOffsetMs("2026-11-05T12:00:00.000Z", receivedAt);
  assert.equal(offset, -5000);
  assert.equal(passRemainingMs(pass(), offset, receivedAt), 90_000);
  assert.equal(passRemainingMs(pass(), offset, receivedAt + 89_000), 1000);
  assert.equal(isPassUsable(pass(), offset, receivedAt + 90_000), false);
  assert.equal(formatCountdown(90_000), "1:30");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-500), "0:00");
});

test("auto regeneration is bounded and never runs hidden, offline or stopped", () => {
  assert.equal(shouldAutoRenew({ visible: false, online: true, statusAvailable: true, renewals: 0, stopped: false }), false);
  assert.equal(shouldAutoRenew({ visible: true, online: false, statusAvailable: true, renewals: 0, stopped: false }), false);
  assert.equal(shouldAutoRenew({ visible: true, online: true, statusAvailable: true, renewals: 0, stopped: true }), false);
  assert.equal(shouldAutoRenew({ visible: true, online: true, statusAvailable: true, renewals: MAX_AUTO_RENEWALS_WITH_STATUS - 1, stopped: false }), true);
  assert.equal(shouldAutoRenew({ visible: true, online: true, statusAvailable: true, renewals: MAX_AUTO_RENEWALS_WITH_STATUS, stopped: false }), false);
  assert.equal(shouldAutoRenew({ visible: true, online: true, statusAvailable: false, renewals: MAX_AUTO_RENEWALS_WITHOUT_STATUS - 1, stopped: false }), true);
  assert.equal(shouldAutoRenew({ visible: true, online: true, statusAvailable: false, renewals: MAX_AUTO_RENEWALS_WITHOUT_STATUS, stopped: false }), false);
});

test("QR value carries the pass in the fragment, never in the query", () => {
  const value = buildResidentPassQrValue("https://padlhub.su/admin/residency/check", TOKEN, "station-1");
  assert.equal(value, "https://padlhub.su/admin/residency/check#pass=" + TOKEN + "&stationId=station-1");
  assert.ok(!value?.includes("?"), "fragment QR must not put the token in a query");
  assert.equal(
    buildResidentPassQrValue("https://padlhub.su/admin/residency/check/", TOKEN, null),
    "https://padlhub.su/admin/residency/check#pass=" + TOKEN,
  );
  // Query/hash on the configured base are discarded: the token must not leak into a server log.
  assert.equal(
    buildResidentPassQrValue("https://padlhub.su/admin/residency/check?x=1#y", TOKEN, null),
    "https://padlhub.su/admin/residency/check#pass=" + TOKEN,
  );
  assert.equal(buildResidentPassQrValue("https://padlhub.su/check", "not-a-token", null), null);
  assert.equal(buildResidentPassQrValue("javascript:alert(1)", TOKEN, null), null);
});

test("pass payload validation rejects incomplete or foreign shapes", () => {
  assert.equal(isResidentPassPayload(pass()), true);
  assert.equal(isResidentPassPayload({ ...pass(), schemaVersion: 2 }), false);
  assert.equal(isResidentPassPayload({ ...pass(), passToken: "token" }), false);
  assert.equal(isResidentPassPayload({ ...pass(), passId: "resident_pass:x" }), false);
  assert.equal(isResidentPassPayload({ ...pass(), expiresAt: "2026-11-05T11:00:00.000Z" }), false);
  assert.equal(isResidentPassPayload(null), false);
  assert.equal(isResidentPassStatusPayload({ schemaVersion: 1, statusAvailable: false, state: "UNKNOWN" }), true);
  assert.equal(isResidentPassStatusPayload({ schemaVersion: 1, statusAvailable: true, state: "CONSUMED" }), true);
  assert.equal(isResidentPassStatusPayload({ schemaVersion: 1, statusAvailable: true, state: "PWNED" }), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_legacy_payment_confirm_to_canonical.js",
  "utf8",
);

function run(message: Record<string, unknown>) {
  const envValues: Record<string, string> = {
    PADLHUB_PLATFORM_INTERNAL_API_BASE_URL: "https://platform.example/internal/api/v1/local-padel",
    PADLHUB_PLATFORM_TENANT_KEY: "tenant-1",
    PADLHUB_LEGACY_ROSTER_TOKEN: "x".repeat(32),
  };
  const env = { get: (key: string) => envValues[key] };
  return new Function("msg", "env", source)(message, env) as unknown[];
}

function paymentMessage(exerciseId?: string) {
  return {
    _legacyPaymentConfirm: {
      gameId: "legacy-game-1",
      idempotencyKey: "payment-confirm-1",
      operationType: "TRANSACTION",
      operationId: "transaction-1",
      bookingId: "booking-1",
      expectedExerciseId: "exercise-1",
      reservationId: "reservation-1",
      authorization: "Bearer user-token",
    },
    _verifiedPaymentEvidence: {
      operationType: "TRANSACTION",
      operationId: "transaction-1",
      bookingId: "booking-1",
      ...(exerciseId ? { exerciseId } : {}),
      clientPhoneE164: "+79990000001",
      verifiedAt: "2026-08-17T08:00:00.000Z",
    },
  };
}

test("canonical payment confirmation forwards the verified Viva exercise binding", () => {
  const out = run(paymentMessage("exercise-1"));
  const request = out[0] as {
    payload?: { evidence?: { exerciseId?: string } };
    headers?: Record<string, string>;
  };

  assert.equal(request.payload?.evidence?.exerciseId, "exercise-1");
  assert.equal(request.headers?.["Idempotency-Key"], "payment-confirm-1");
  assert.equal(out[1], null);
});

test("canonical payment confirmation rejects evidence without an exercise binding", () => {
  const out = run(paymentMessage());
  const response = out[1] as { statusCode?: number; payload?: { code?: string } };

  assert.equal(out[0], null);
  assert.equal(response.statusCode, 409);
  assert.equal(response.payload?.code, "LEGACY_PAYMENT_EVIDENCE_MISMATCH");
});

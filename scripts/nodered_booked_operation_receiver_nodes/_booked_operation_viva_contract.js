// Profile verification and local canonical subscription-booking owner contract.
// Concatenated into the executor Function node. The canonical owner alone owns
// subscription policy, daily claims, admin service credentials and provider readback.

const BOOKED_OP_VIVA_DEFAULT_API_BASE = "https://api.vivacrm.ru";
const BOOKED_OP_VIVA_DEFAULT_PROFILE_PATH = "/end-user/api/v1/{tenant_key}/profile";
const BOOKED_OP_VIVA_DEFAULT_TIMEOUT_MS = 15000;
const BOOKED_OP_VIVA_MIN_TIMEOUT_MS = 1000;
const BOOKED_OP_VIVA_MAX_TIMEOUT_MS = 60000;
const BOOKED_OP_VIVA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BOOKED_OP_VIVA_TOKEN = /^[!-~]{16,4096}$/;
const BOOKED_OP_VIVA_SHA256 = /^sha256:[a-f0-9]{64}$/;
const BOOKED_OP_VIVA_API_BASE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253})(?::\d{2,5})?(?:\/[!-~]*)?$/;
const BOOKED_OP_VIVA_PATH = /^\/[!-~]*$/;

const bookedOperationVivaIsObject = (value) => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value);
const bookedOperationVivaToText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const bookedOperationVivaEnv = (env, name) => {
  try {
    return bookedOperationVivaToText(env.get(name));
  } catch (_error) {
    return null;
  }
};
const bookedOperationVivaNormalizeId = (value) => (
  bookedOperationVivaToText(value)?.toLowerCase() || null
);
const bookedOperationVivaSha256Hex = (text) => nodeCrypto
  .createHash("sha256")
  .update(text, "utf8")
  .digest("hex");
const bookedOperationVivaIsCanonicalIso = (value) => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const bookedOperationVivaNormalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

// Server env only. `BOOKED_OPERATION_EXECUTION_ENABLED` is the single activation
// switch (default off); the Viva endpoints are configurable so the adapter can be
// pointed at a mock/sandbox before any real execution.
const bookedOperationVivaReadExecutionConfig = (env) => {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(bookedOperationVivaEnv(env, "BOOKED_OPERATION_EXECUTION_ENABLED") || "").toLowerCase(),
  );
  if (!enabled) {
    return { ok: false, code: "BOOKED_OPERATION_EXECUTION_DISABLED" };
  }
  const apiBase = (
    bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_VIVA_API_BASE")
    || BOOKED_OP_VIVA_DEFAULT_API_BASE
  ).replace(/\/+$/, "");
  const profilePath = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_VIVA_PROFILE_PATH")
    || BOOKED_OP_VIVA_DEFAULT_PROFILE_PATH;
  // Credential-bearing delegation stays on the local canonical booking owner. The owner
  // owns the admin service token, subscription eligibility, claims and provider readback.
  const ownerBase = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_OWNER_BASE_URL");
  const ownerTenantKey = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_OWNER_TENANT_KEY");
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(ownerBase || "")
    || ownerTenantKey !== "iSkq6G") {
    return { ok: false, code: "BOOKED_OPERATION_EXECUTION_CONFIG_INVALID" };
  }
  const timeoutText = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_EXECUTION_TIMEOUT_MS");
  const timeoutMs = timeoutText === null ? BOOKED_OP_VIVA_DEFAULT_TIMEOUT_MS : Number(timeoutText);
  if (
    apiBase.length > 256 || !BOOKED_OP_VIVA_API_BASE.test(apiBase) || apiBase.includes("@")
    || !BOOKED_OP_VIVA_PATH.test(profilePath) || profilePath.length > 512 || profilePath.includes("#")
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < BOOKED_OP_VIVA_MIN_TIMEOUT_MS || timeoutMs > BOOKED_OP_VIVA_MAX_TIMEOUT_MS
  ) {
    return { ok: false, code: "BOOKED_OPERATION_EXECUTION_CONFIG_INVALID" };
  }
  return {
    ok: true,
    config: { apiBase, profilePath, ownerBase, ownerTenantKey, timeoutMs },
  };
};

// Expands exactly the documented placeholders; an unknown or missing value keeps
// the message off the wire instead of producing a relative/partial URL.
const bookedOperationVivaExpandPath = (template, values) => {
  if (typeof template !== "string") return null;
  let unresolved = false;
  const expanded = template.replace(/\{([a-z_]+)\}/g, (_match, key) => {
    const value = bookedOperationVivaToText(values[key]);
    if (!value) {
      unresolved = true;
      return "";
    }
    return encodeURIComponent(value);
  });
  return unresolved ? null : expanded;
};

const bookedOperationVivaIsHttpOk = (status) => Number(status) >= 200 && Number(status) < 300;
const bookedOperationVivaUnwrapRecord = (value) => {
  if (!bookedOperationVivaIsObject(value)) return null;
  if (bookedOperationVivaToText(
    value.id || value.uuid || value.exerciseId || value.clientId,
  )) return value;
  for (const key of ["data", "payload", "result"]) {
    if (bookedOperationVivaIsObject(value[key])) {
      return bookedOperationVivaUnwrapRecord(value[key]) || value[key];
    }
  }
  return value;
};
// Strict mongodb4 updateOne acknowledgement. Only a definite non-upsert match is
// a dispatch/confirm claim; anything else is an ambiguity, never success.
const bookedOperationVivaMongoUpdateAck = (value, expected) => {
  const keys = ["acknowledged", "matchedCount", "modifiedCount", "upsertedCount", "upsertedId"];
  if (
    !bookedOperationVivaIsObject(value)
    || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))
    || value.acknowledged !== true
    || ![0, 1].includes(value.matchedCount)
    || ![0, 1].includes(value.modifiedCount)
    || value.modifiedCount > value.matchedCount
    || value.upsertedCount !== 0
    || value.upsertedId !== null
  ) {
    return null;
  }
  if (expected === "MATCHED" && value.matchedCount !== 1) return null;
  if (expected === "NONE" && value.matchedCount !== 0) return null;
  return { matched: value.matchedCount };
};

const bookedOperationOwnerReceipt = (stored, bookingId, verifiedAt) => ({
  contractVersion: 1,
  source: "LK1_SUBSCRIPTION_BOOKING_OWNER",
  operationId: stored.operationId,
  tenantId: stored.tenantId,
  userId: stored.userId,
  gameId: stored.targetId,
  reservationId: stored.reservationId,
  providerClientId: stored.providerClientId,
  providerClientSubscriptionId: stored.providerClientSubscriptionId,
  providerExerciseId: stored.providerExerciseId,
  providerMappingId: stored.providerMappingId,
  targetMappingId: stored.targetMappingId,
  targetVersion: stored.targetVersion,
  requestSha256: stored.requestSha256,
  idempotencyKeySha256: stored.idempotencyKeySha256,
  bookingId,
  verifiedAt,
});

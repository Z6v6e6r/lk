// Shared Viva provider request contract for the booked-operation execution adapter.
//
// This file is a function body (not a module). The patch script concatenates it
// in front of fn_booked_operation_executor.js, so the exact profile read, booking
// write and confirmation readback contract is defined once for the receiver.
//
// The contract is factored from the existing atomic subscription-booking
// machinery and must stay identical to it (characterisation test:
// bookedOperationReceiverExecution.test.mjs):
//   - fn_subscription_booking_prepare.js: user Bearer -> GET end-user profile
//   - fn_subscription_booking_router.js: POST /api/v2/exercises/{id}/bookings
//     with paymentType "SUBSCRIPTION", clientId, clientSubscriptionId,
//     customFields [], then a GET bookings readback for confirmation.
//
// No key, credential or environment-specific value is stored here. The API base
// and the path templates come from the server env (see HANDOFF-LK1.md); the
// defaults below are the public production endpoints already hardcoded by the
// existing subscription-booking sources.

const BOOKED_OP_VIVA_DEFAULT_API_BASE = "https://api.vivacrm.ru";
const BOOKED_OP_VIVA_DEFAULT_PROFILE_PATH = "/end-user/api/v1/{tenant_key}/profile";
const BOOKED_OP_VIVA_DEFAULT_BOOKING_PATH = "/api/v2/exercises/{provider_exercise_id}/bookings";
const BOOKED_OP_VIVA_DEFAULT_READBACK_PATH = "/end-user/api/v2/{tenant_key}/bookings?size=1000";
const BOOKED_OP_VIVA_PAYMENT_TYPE = "SUBSCRIPTION";
const BOOKED_OP_VIVA_DEFAULT_TIMEOUT_MS = 15000;
const BOOKED_OP_VIVA_MIN_TIMEOUT_MS = 1000;
const BOOKED_OP_VIVA_MAX_TIMEOUT_MS = 60000;
const BOOKED_OP_VIVA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BOOKED_OP_VIVA_TOKEN = /^[!-~]{16,4096}$/;
const BOOKED_OP_VIVA_SHA256 = /^sha256:[a-f0-9]{64}$/;
const BOOKED_OP_VIVA_API_BASE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253})(?::\d{2,5})?(?:\/[!-~]*)?$/;
const BOOKED_OP_VIVA_PATH = /^\/[!-~]*$/;
const BOOKED_OP_VIVA_REJECTION = /^[A-Z][A-Z0-9_]{2,63}$/;

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
  const bookingPath = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_VIVA_BOOKING_PATH")
    || BOOKED_OP_VIVA_DEFAULT_BOOKING_PATH;
  const readbackPath = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_VIVA_READBACK_PATH")
    || BOOKED_OP_VIVA_DEFAULT_READBACK_PATH;
  const timeoutText = bookedOperationVivaEnv(env, "LK1_BOOKED_OPERATION_EXECUTION_TIMEOUT_MS");
  const timeoutMs = timeoutText === null ? BOOKED_OP_VIVA_DEFAULT_TIMEOUT_MS : Number(timeoutText);
  if (
    apiBase.length > 256 || !BOOKED_OP_VIVA_API_BASE.test(apiBase) || apiBase.includes("@")
    || !BOOKED_OP_VIVA_PATH.test(profilePath) || profilePath.length > 512 || profilePath.includes("#")
    || !BOOKED_OP_VIVA_PATH.test(bookingPath) || bookingPath.length > 512 || bookingPath.includes("#")
    || !BOOKED_OP_VIVA_PATH.test(readbackPath) || readbackPath.length > 512 || readbackPath.includes("#")
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < BOOKED_OP_VIVA_MIN_TIMEOUT_MS || timeoutMs > BOOKED_OP_VIVA_MAX_TIMEOUT_MS
  ) {
    return { ok: false, code: "BOOKED_OPERATION_EXECUTION_CONFIG_INVALID" };
  }
  return {
    ok: true,
    config: { apiBase, profilePath, bookingPath, readbackPath, timeoutMs },
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

// Mirrors prepareBookingCreate in the subscription-booking router: the user
// profile supplies clientId/phone, the operation supplies the exercise and the
// exact clientSubscriptionId. No spot, no service identity, no full-price path.
const bookedOperationVivaBookingPayload = ({ clientId, phone, clientSubscriptionId }) => {
  const digits = bookedOperationVivaNormalizePhone(phone);
  return {
    clientId,
    ...(digits ? { phone: `+${digits}` } : {}),
    paymentType: BOOKED_OP_VIVA_PAYMENT_TYPE,
    clientSubscriptionId,
    customFields: [],
  };
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
const bookedOperationVivaExtractItems = (value, seen = new Set()) => {
  if (Array.isArray(value)) return value;
  if (!bookedOperationVivaIsObject(value) || seen.has(value)) return [];
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings", "data", "payload", "result"]) {
    if (Array.isArray(value[key])) return value[key];
    const nested = bookedOperationVivaExtractItems(value[key], seen);
    if (nested.length > 0) return nested;
  }
  return [];
};
const bookedOperationVivaHasBookingList = (value, seen = new Set()) => {
  if (Array.isArray(value)) return true;
  if (!bookedOperationVivaIsObject(value) || seen.has(value)) return false;
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings"]) {
    if (Array.isArray(value[key])) return true;
  }
  return ["data", "payload", "result"].some((key) => (
    bookedOperationVivaHasBookingList(value[key], seen)
  ));
};
const bookedOperationVivaBookingId = (value) => (
  bookedOperationVivaIsObject(value)
    ? bookedOperationVivaToText(value.id || value.bookingId || value.uuid)
    : null
);
const bookedOperationVivaBookingExerciseId = (value) => {
  if (!bookedOperationVivaIsObject(value)) return null;
  const exercise = bookedOperationVivaIsObject(value.exercise) ? value.exercise : null;
  return bookedOperationVivaToText(
    exercise?.id || exercise?.uuid || value.exerciseId || value.vivaExerciseId || value.eventId,
  );
};
const bookedOperationVivaBookingSubscriptionId = (value) => {
  if (!bookedOperationVivaIsObject(value)) return null;
  const subscription = bookedOperationVivaIsObject(value.subscription)
    ? value.subscription
    : (
      bookedOperationVivaIsObject(value.clientSubscription)
        ? value.clientSubscription
        : null
    );
  return bookedOperationVivaToText(
    value.clientSubscriptionId
    || value.subscriptionId
    || value.clientSubId
    || subscription?.clientSubscriptionId
    || subscription?.subscriptionId
    || subscription?.id
    || subscription?.uuid,
  );
};
const bookedOperationVivaIsInactiveBooking = (value) => {
  if (!bookedOperationVivaIsObject(value)) return true;
  const exercise = bookedOperationVivaIsObject(value.exercise) ? value.exercise : null;
  if (
    value.isCancelled === true
    || value.cancelled === true
    || value.canceled === true
    || value.archived === true
    || bookedOperationVivaToText(value.cancellationDate)
    || bookedOperationVivaToText(value.cancelledAt)
    || exercise?.isCancelled === true
    || exercise?.cancelled === true
    || exercise?.canceled === true
    || exercise?.archived === true
  ) return true;
  const statuses = [
    value.status,
    value.state,
    value.bookingStatus,
    value.cancellationReason,
    exercise?.status,
    exercise?.state,
    value.transactionStatus?.transactionStatus,
    value.transactionStatus?.cardPaymentStatus?.status,
    value.transactionStatus?.cardPaymentStatus?.originalStatus,
  ];
  return statuses.some((status) => (
    /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|ARCHIVE|REMOV/i.test(String(status || ""))
  ));
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

// A provider rejection body may only become a bounded upper-case code; raw text
// and the full payload never reach Mongo or the response.
const bookedOperationVivaRejectionCode = (payload) => {
  const raw = bookedOperationVivaIsObject(payload)
    ? bookedOperationVivaToText(
      payload.code
      || (bookedOperationVivaIsObject(payload.error) ? payload.error.code : payload.error)
      || payload.message,
    )
    : null;
  if (!raw) return null;
  const normalised = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return BOOKED_OP_VIVA_REJECTION.test(normalised) ? normalised : null;
};

#!/usr/bin/env node
/**
 * Controlled behavioural probe for the split "participant share" fix.
 *
 * It performs ONE real participant join on a designated game, asserts that the server
 * reports the exact court share (never the fabricated nominal), and then immediately
 * cancels the created Viva booking again. The payment link is never opened or paid.
 *
 * Mandatory environment:
 *   SPLIT_JOIN_PROBE=CONFIRM_VIVA_BOOKING   explicit acknowledgement of the real booking
 *   SPLIT_JOIN_PROBE_TOKEN=<user bearer>    session of the test identity
 *   SPLIT_JOIN_PROBE_PHONE=<phone>          test phone that exists in Viva
 *   SPLIT_JOIN_PROBE_GAME_ID=<pay_...>      game where a short-lived test booking is acceptable
 *
 * Optional:
 *   SPLIT_JOIN_PROBE_API_BASE (default https://padlhub.su)
 *   SPLIT_JOIN_PROBE_CLIENT_ID
 *   SPLIT_JOIN_PROBE_REASON (default SPLIT_SHARE_PROBE_CLEANUP)
 *   SPLIT_JOIN_PROBE_KEEP_BOOKING=1         skip the automatic cancellation (not recommended)
 */
const API_BASE = (process.env.SPLIT_JOIN_PROBE_API_BASE || "https://padlhub.su").replace(/\/+$/, "");
const VIVA_BASE = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const ACK = "CONFIRM_VIVA_BOOKING";

const maskPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
};
const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const isObj = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const round2 = (value) => Math.round(value * 100) / 100;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "error" });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  return { status: response.status, payload };
}

async function fetchGame(gameId) {
  const { status, payload } = await httpJson(`${API_BASE}/lk/games/${encodeURIComponent(gameId)}`, {
    headers: { accept: "application/json" },
  });
  if (status !== 200 || !isObj(payload) || payload.id !== gameId) {
    throw new Error(`Game ${gameId} is not readable (http ${status})`);
  }
  return payload;
}

async function resolveExactShareOnce(game, shareCount) {
  const booking = isObj(game.booking) ? game.booking : {};
  const query = new URLSearchParams({
    studioId: String(booking.studioId || ""),
    roomId: String(booking.roomId || ""),
    subServiceIds: (booking.subServiceIds || []).join(","),
    fromTime: String(booking.timeFrom || ""),
    toTime: String(booking.timeTo || ""),
    fromDate: String(booking.date || ""),
  });
  const masterServiceId = String(booking.masterServiceId || "");
  if (!masterServiceId || !query.get("subServiceIds")) {
    throw new Error("Game booking lacks the exact-price contract (master service / sub-services)");
  }
  const { status, payload } = await httpJson(
    `${VIVA_BASE}/products/master-services/${encodeURIComponent(masterServiceId)}/price?${query.toString()}`,
    { headers: { accept: "application/json" } },
  );
  if (status !== 200 || !isObj(payload)) throw new Error(`Viva price lookup failed (http ${status})`);
  const entry = payload[query.get("subServiceIds").split(",")[0]] || Object.values(payload)[0];
  const total = toNumber(isObj(entry) ? (entry.from ?? entry.valueFrom) : null);
  if (total === null || total <= 0) throw new Error("Viva price lookup returned no usable price");
  return { totalAmount: round2(total), shareAmount: round2(total / shareCount) };
}

async function resolveExactShare(game, shareCount, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await resolveExactShareOnce(game, shareCount);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function fetchProfile(token) {
  const { status, payload } = await httpJson(`${VIVA_BASE}/profile`, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (status !== 200 || !isObj(payload)) throw new Error(`Profile lookup failed (http ${status})`);
  return payload;
}

function assertProbeIdentity(game, { clientId, phone }) {
  const organizerId = isObj(game.organizer) ? String(game.organizer.id || "").trim() : "";
  const digits = (value) => String(value || "").replace(/\D/g, "");
  if (clientId && organizerId && clientId === organizerId) {
    throw new Error("The probe identity is the organizer of this game");
  }
  const activeStatuses = /^(CONFIRMED|PAID|PAYMENT_PENDING|PENDING|WAITLIST)$/i;
  const participants = [...(Array.isArray(game.participants) ? game.participants : []),
    ...(Array.isArray(game.waitlist) ? game.waitlist : [])];
  if (participants.some((player) => isObj(player)
    && ((clientId && String(player.id || "") === clientId)
      || (phone && digits(player.phone) === digits(phone))))) {
    throw new Error("The probe identity is already in this game roster");
  }
  const splitPayment = isObj(game.metadata) && isObj(game.metadata.splitPayment) ? game.metadata.splitPayment : {};
  const payments = Array.isArray(splitPayment.payments) ? splitPayment.payments : [];
  if (payments.some((item) => isObj(item) && activeStatuses.test(String(item.status || ""))
    && ((clientId && String(item.clientId || "") === clientId)
      || (phone && digits(item.phone || item.phoneNorm) === digits(phone))))) {
    throw new Error("The probe identity already has an active split payment in this game");
  }
}

async function leaveBooking({ gameId, token, bookingId, exerciseId, clientId, phone, reason }) {
  const { status, payload } = await httpJson(`${API_BASE}/lk/games/${encodeURIComponent(gameId)}/split/leave`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      bookingIds: bookingId ? [bookingId] : [],
      exerciseId: exerciseId || null,
      clientId: clientId || null,
      playerPhone: phone,
      reason,
    }),
  });
  return { status, ok: status >= 200 && status < 300, payload };
}

function resolveCanonicalStoredShare(game) {
  const splitPayment = isObj(game.metadata) && isObj(game.metadata.splitPayment) ? game.metadata.splitPayment : {};
  const stored = toNumber(splitPayment.shareAmount);
  const total = toNumber(splitPayment.totalAmount);
  return total !== null && total > 0 && stored !== null && stored > 0 ? stored : null;
}

async function resolveExpectedShare(game, shareCount) {
  const explicit = toNumber(String(process.env.SPLIT_JOIN_PROBE_EXPECTED_SHARE || "").trim());
  if (explicit !== null && explicit > 0) return { shareAmount: explicit, source: "explicit" };
  try {
    const exact = await resolveExactShare(game, shareCount);
    return { shareAmount: exact.shareAmount, source: "viva", totalAmount: exact.totalAmount };
  } catch (error) {
    const canonical = resolveCanonicalStoredShare(game);
    if (canonical !== null) {
      return { shareAmount: canonical, source: "stored-canonical", priceLookupError: error.message };
    }
    throw new Error(`Cannot establish the expected share: ${error.message}`);
  }
}

async function main() {
  const dryRun = String(process.env.SPLIT_JOIN_PROBE_DRY_RUN || "") === "1";
  const gameId = required("SPLIT_JOIN_PROBE_GAME_ID");
  if (dryRun) {
    // Read-only rehearsal: resolves the exact court share and the stored share, no join.
    const game = await fetchGame(gameId);
    const splitPayment = isObj(game.metadata) && isObj(game.metadata.splitPayment) ? game.metadata.splitPayment : {};
    const shareCount = Number(splitPayment.shareCount) === 2 ? 2 : 4;
    let expected = null;
    let expectedError = null;
    try {
      expected = await resolveExpectedShare(game, shareCount);
    } catch (error) {
      // A past slot is rejected by Viva ("fromDate must not be in the past"): the probe
      // needs a future game, and the operator needs to know why.
      expectedError = error.message;
    }
    console.log(JSON.stringify({
      formatVersion: 1,
      mode: "dry-run",
      mutationPerformed: false,
      gameId,
      date: isObj(game.booking) ? game.booking.date : null,
      shareCount,
      storedShareAmount: toNumber(splitPayment.shareAmount),
      expectedShareAmount: expected ? expected.shareAmount : null,
      expectedSource: expected ? expected.source : null,
      expectedTotalAmount: expected ? (expected.totalAmount ?? null) : null,
      expectedError,
      nominalFallbackInStoredShare: toNumber(splitPayment.shareAmount) === (shareCount === 2 ? 5000 : 2500),
    }, null, 2));
    return;
  }
  if (String(process.env.SPLIT_JOIN_PROBE || "") !== ACK) {
    throw new Error(`Set SPLIT_JOIN_PROBE=${ACK} to acknowledge the real Viva booking`);
  }
  const token = required("SPLIT_JOIN_PROBE_TOKEN");
  const requestedPhone = String(process.env.SPLIT_JOIN_PROBE_PHONE || "").trim();
  const requestedClientId = String(process.env.SPLIT_JOIN_PROBE_CLIENT_ID || "").trim();
  let profile = null;
  if (!requestedPhone || !requestedClientId) {
    // The authenticated session is the probe identity: resolve the phone and client id
    // from it instead of requiring them separately.
    profile = await fetchProfile(token);
  }
  const phone = requestedPhone || String(profile?.phone || "").trim();
  if (!phone) throw new Error("SPLIT_JOIN_PROBE_PHONE is required (the session profile has no phone)");
  const clientId = requestedClientId || String(profile?.id || "").trim() || null;
  const reason = String(process.env.SPLIT_JOIN_PROBE_REASON || "").trim() || "SPLIT_SHARE_PROBE_CLEANUP";
  const keepBooking = String(process.env.SPLIT_JOIN_PROBE_KEEP_BOOKING || "") === "1";

  const game = await fetchGame(gameId);
  assertProbeIdentity(game, { clientId, phone });
  const booking = isObj(game.booking) ? game.booking : {};
  const splitPayment = isObj(game.metadata) && isObj(game.metadata.splitPayment) ? game.metadata.splitPayment : {};
  const shareCount = Number(splitPayment.shareCount) === 2 ? 2 : 4;
  const storedShare = toNumber(splitPayment.shareAmount);
  const expected = await resolveExpectedShare(game, shareCount);
  // Deliberately send the fabricated nominal: the one-time path must replace it with the
  // exact court share, which is exactly what this probe asserts.
  const nominalShareAmount = shareCount === 2 ? 5000 : 2500;

  const paymentRef = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const joinBody = {
    date: booking.date,
    fromTime: booking.timeFrom,
    toTime: booking.timeTo,
    exerciseId: booking.vivaExerciseId || booking.exerciseId || null,
    vivaExerciseId: booking.vivaExerciseId || booking.exerciseId || null,
    studioId: booking.studioId,
    roomId: booking.roomId,
    masterServiceId: booking.masterServiceId || null,
    subServiceIds: booking.subServiceIds || [],
    clientId,
    clientPhone: phone,
    paymentRef,
    paymentMode: "one_time",
    shareCount,
    // The probe deliberately sends the stored (possibly nominal) amount: the one-time
    // path must replace it with the exact court share, which is what we assert below.
    shareAmount: nominalShareAmount,
    shareAmountIncludesDuration: true,
    durationMinutes: booking.durationMinutes ?? null,
    maxClientsCount: shareCount,
    spot: null,
    baseRedirectUrl: `${API_BASE}/game_join?joinGame=${encodeURIComponent(gameId)}`,
  };

  const join = await httpJson(`${API_BASE}/lk/games/${encodeURIComponent(gameId)}/split/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(joinBody),
  });

  const receipt = {
    formatVersion: 1,
    gameId,
    date: booking.date,
    timeFrom: booking.timeFrom,
    shareCount,
    storedShareAmount: storedShare,
    requestShareAmount: nominalShareAmount,
    expectedShareAmount: expected.shareAmount,
    expectedShareSource: expected.source,
    expectedTotalAmount: expected.totalAmount ?? null,
    priceLookupError: expected.priceLookupError ?? null,
    joinStatus: join.status,
    joinShareAmount: toNumber(join.payload?.shareAmount),
    joinToPay: toNumber(join.payload?.toPay),
    joinBookingId: join.payload?.bookingId ?? null,
    joinTransactionId: join.payload?.transactionId ?? null,
    paymentUrlIssued: Boolean(join.payload?.paymentUrl),
    paymentLinkOpened: false,
    phoneMasked: maskPhone(phone),
    probeIdentitySource: requestedPhone ? "env" : "session-profile",
    cleanup: null,
  };

  const joinFailed = join.status < 200 || join.status >= 300 || join.payload?.ok !== true;
  const shareMismatch = receipt.joinShareAmount !== null && receipt.joinShareAmount !== expected.shareAmount;
  const toPayMismatch = receipt.joinToPay !== null && receipt.joinToPay !== expected.shareAmount;
  const nominalLeaked = expected.shareAmount !== nominalShareAmount
    && (receipt.joinShareAmount === nominalShareAmount || receipt.joinToPay === nominalShareAmount);
  receipt.nominalShareLeaked = nominalLeaked;

  if (!keepBooking && receipt.joinBookingId) {
    const left = await leaveBooking({
      gameId,
      token,
      bookingId: receipt.joinBookingId,
      exerciseId: joinBody.exerciseId,
      clientId,
      phone,
      reason,
    });
    receipt.cleanup = { status: left.status, ok: left.ok };
    if (!left.ok) {
      console.error(JSON.stringify({ ...receipt, error: "CLEANUP_FAILED" }, null, 2));
      console.error(
        "Manual cleanup required: POST " + `${API_BASE}/lk/games/${gameId}/split/leave`
        + " with bookingIds=[" + receipt.joinBookingId + "], playerPhone, reason=" + reason,
      );
      process.exitCode = 3;
      return;
    }
  }

  console.log(JSON.stringify(receipt, null, 2));
  if (joinFailed || shareMismatch || toPayMismatch || nominalLeaked) {
    console.error("Probe assertions failed");
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

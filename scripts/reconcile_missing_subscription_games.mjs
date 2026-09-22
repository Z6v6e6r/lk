#!/usr/bin/env node
// Reconcile confirmed subscription open-game operations that have no LK game record.
//
// Background: the LK game for a split/subscription create is written by the browser only after
// the gateway confirms the booking. A browser abort (nginx 499) or a create that keeps
// answering 202 PENDING_CONFIRMATION leaves a confirmed Viva booking without a game, and the
// frontend conversion guard then refuses to publish it as an ordinary game.
//
// This script is the operational counter and repair path. It is dry-run by default and only
// restores subscription-covered bookings, where ORGANIZER PAID 0 <amount> is true. One-time and
// ON_PLACE gaps are reported for manual handling because their money state cannot be rebuilt.
//
// Usage (run where MongoDB is reachable, normally the Node-RED host):
//   node scripts/reconcile_missing_subscription_games.mjs --hours 48
//   node scripts/reconcile_missing_subscription_games.mjs --hours 48 --apply
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};
const hasFlag = (name) => argv.includes(name);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const list = (value) => (Array.isArray(value)
  ? value
  : value && typeof value === "object" && Array.isArray(value.content)
    ? value.content
    : []);

export const GAP_REASONS = Object.freeze({
  RESTORABLE: "restorable_subscription",
  MANUAL_PAYMENT: "manual_payment_mode",
  CANCELLED: "cancelled",
  UNRESOLVED: "unresolved",
});

/**
 * Classify one confirmed operation that has no LK game.
 * `exercise` and `rosterBooking` are Viva Admin payloads; `services` comes from an existing
 * game on the same court.
 */
export function classifyMissingGame({ exercise, rosterBooking, services, shareAmountMinor }) {
  const reasons = [];
  if (!exercise || exercise.canceled === true) reasons.push("exercise_cancelled");
  const bookingCancelled = rosterBooking?.isCancelled === true || rosterBooking?.cancelled === true;
  if (!rosterBooking) reasons.push("booking_missing");
  else if (bookingCancelled) reasons.push("booking_cancelled");
  if (!services?.masterServiceId || !(services?.subServiceIds || []).length) {
    reasons.push("studio_services_unknown");
  }
  if (!Number.isFinite(shareAmountMinor) || shareAmountMinor <= 0) reasons.push("share_amount_unresolved");
  if (reasons.includes("exercise_cancelled") || reasons.includes("booking_cancelled")) {
    return { kind: GAP_REASONS.CANCELLED, reasons };
  }
  const paymentType = toStr(rosterBooking?.paymentType);
  const clientSubscriptionId = toStr(rosterBooking?.clientSubscriptionId);
  if (paymentType !== "SUBSCRIPTION" || !clientSubscriptionId) {
    return { kind: GAP_REASONS.MANUAL_PAYMENT, reasons: [...reasons, "payment_not_subscription"] };
  }
  if (reasons.length > 0) return { kind: GAP_REASONS.UNRESOLVED, reasons };
  return { kind: GAP_REASONS.RESTORABLE, reasons };
}

/** Build the canonical `games_split_widget` payload that the browser would have created. */
export function buildRestoredGamePayload({
  operation, exercise, client, rosterBooking, services, shareAmountMinor, nowIso = new Date().toISOString(),
}) {
  const exerciseId = toStr(operation.exerciseId);
  const bookingId = toStr(operation.bookingId || operation.upstreamBookingId);
  const actorId = toStr(operation.actorClientId);
  const timeFromIso = toStr(exercise?.timeFrom);
  const timeToIso = toStr(exercise?.timeTo);
  const durationMinutes = timeFromIso && timeToIso
    ? Math.round((Date.parse(timeToIso) - Date.parse(timeFromIso)) / 60000)
    : null;
  const shareCount = Math.max(1, Math.round(Number(exercise?.maxClientsCount) || 4));
  const shareAmount = shareAmountMinor / 100;
  const totalAmount = shareAmount * shareCount;
  const paymentRef = crypto.randomUUID();
  const name = [client?.firstName, client?.lastName].filter(Boolean).join(" ").trim() || "Организатор";
  const phone = normalizePhone(client?.phone);
  const clientSubscriptionId = toStr(rosterBooking?.clientSubscriptionId) || toStr(operation.clientSubscriptionId);
  return {
    paymentRef,
    tenantKey: null,
    status: "PAID",
    organizer: {
      id: actorId, name, phone, photo: toStr(client?.photo) || null, rating: null, ratingNumeric: null,
    },
    booking: {
      studioId: toStr(exercise?.studio?.id),
      studioName: toStr(exercise?.studio?.name) || "Станция",
      masterServiceId: services.masterServiceId,
      subServiceIds: services.subServiceIds,
      roomId: toStr(exercise?.room?.id),
      roomName: toStr(exercise?.room?.name) || "Корт",
      date: timeFromIso ? timeFromIso.slice(0, 10) : null,
      timeFrom: timeFromIso ? timeFromIso.slice(11, 16) : null,
      timeTo: timeToIso ? timeToIso.slice(11, 16) : null,
      timeFromIso,
      timeToIso,
      durationMinutes,
      slotId: null,
      bookingIds: [bookingId],
      vivaExerciseId: exerciseId,
      exerciseId,
    },
    payment: {
      amount: 0, paymentUrl: null, paymentMethod: "WIDGET", paid: true, paidAt: nowIso,
      paymentRef, bookingIds: [bookingId],
    },
    settings: {
      ratingGame: true, minRating: "D", maxRating: "C", isPrivate: true, payMode: "split",
    },
    invite: { inviteUrl: null, waitlistEnabled: true, maxPlayers: shareCount },
    participants: [{
      id: actorId, name, phone, photo: toStr(client?.photo) || null, rating: null, ratingNumeric: null,
      source: "ORGANIZER", status: "CONFIRMED",
    }],
    waitlist: [],
    metadata: {
      paymentRef,
      bookingIds: [bookingId],
      vivaExerciseId: exerciseId,
      exerciseId,
      source: "games_split_widget",
      sourceMode: "create",
      allRelatedPhones: [phone].filter(Boolean),
      splitPayment: {
        enabled: true, mode: "group_booking", shareCount,
        shareAmount, shareAmountMinor,
        baseShareAmount: shareAmount, baseShareAmountMinor: shareAmountMinor,
        discountAmount: 0, discountAmountMinor: 0,
        deadlineAt: nowIso, assembleDeadlineAt: null, status: "ACTIVE",
        vivaExerciseId: exerciseId, organizerBookingId: bookingId, productId: null,
        directionId: Number(exercise?.direction?.id) || 4588,
        exerciseTypeId: Number(exercise?.type?.id) || 1613,
        totalAmount, oneTimeBaseAmount: totalAmount,
        selectedPaymentMode: "subscription",
        paymentModes: [{
          id: "subscription", label: "Списать посещение с абонемента",
          productId: clientSubscriptionId, productName: null, type: "SUBSCRIPTION",
        }],
        clientSubscriptionId,
        subscriptionProductId: clientSubscriptionId,
        subscriptionProductName: null,
        oneTimeProductId: null,
        oneTimeProductName: null,
        payments: [{
          role: "ORGANIZER", status: "PAID", paymentRef, clientId: actorId, phone, phoneNorm: phone,
          bookingId, transactionId: null, paymentUrl: null, amount: 0, amountMinor: 0,
          paidAt: nowIso, spot: Number(rosterBooking?.spot) || 1,
        }],
        restoredBy: "reconcile_missing_subscription_games",
      },
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchJson = async (url, options = {}, attempts = 5) => {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const raw = await response.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
      return { ok: response.ok, status: response.status, payload: parsed };
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
};

const main = async () => {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log("reconcile_missing_subscription_games [--hours N] [--apply] [--out PATH]");
    return;
  }
  const { MongoClient } = await import("mongodb");
  const hours = Math.max(1, Math.min(24 * 14, Number(getArg("--hours", 48)) || 48));
  const apply = hasFlag("--apply");
  const mongoUri = toStr(getArg("--mongo-uri", process.env.LK_MONGO_URI
    || "mongodb://127.0.0.1:27017/games?authSource=admin&directConnection=true&retryWrites=false"));
  const lkBase = (toStr(getArg("--lk-base", process.env.LK_BASE || "https://padlhub.su/lk")) || "").replace(/\/+$/, "");
  const vivaApiBase = toStr(getArg("--viva-api-base", process.env.VIVA_API_BASE || "https://api.vivacrm.ru/api/v1"));
  const tokenUrl = toStr(getArg("--viva-token-url", process.env.VIVA_TOKEN_URL
    || "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token"));
  const vivaClientId = toStr(getArg("--viva-client-id", process.env.VIVA_CLIENT_ID || "React-auth-dev"));
  const vivaUsername = toStr(getArg("--viva-username", process.env.VIVA_USERNAME));
  const vivaPassword = toStr(getArg("--viva-password", process.env.VIVA_PASSWORD));
  const outPath = path.resolve(toStr(getArg("--out",
    `outputs/missing-subscription-games-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)));

  if (!vivaUsername || !vivaPassword) {
    console.error("Missing Viva credentials (--viva-username/--viva-password or VIVA_USERNAME/VIVA_PASSWORD)");
    process.exit(1);
  }

  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();
  const games = db.collection("lk_games");
  const ops = db.collection("lk_subscription_daily_booking_ops");

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const confirmed = await ops.find({
    updatedAt: { $gte: since }, state: "CONFIRMED", category: "open_game",
  }).toArray();

  const gaps = [];
  for (const op of confirmed) {
    const exerciseId = op.exerciseId;
    const bookingId = op.bookingId || op.upstreamBookingId;
    const exists = await games.countDocuments({ $or: [
      { "metadata.vivaExerciseId": exerciseId }, { "metadata.exerciseId": exerciseId },
      { "booking.exerciseId": exerciseId }, { dedupeKey: `viva:${exerciseId}` },
      { "booking.bookingIds": bookingId }, { "payment.bookingIds": bookingId },
      { "metadata.splitPayment.organizerBookingId": bookingId },
    ] }, { limit: 1 });
    if (exists === 0) gaps.push(op);
  }

  const token = (await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: vivaClientId, username: vivaUsername, password: vivaPassword,
    }),
  })).payload?.access_token;
  if (!token) throw new Error("Viva token request failed");
  const auth = { Authorization: `Bearer ${token}` };

  const report = {
    generatedAt: new Date().toISOString(), apply, hours, mongoUri: mongoUri.replace(/:[^:@]+@/, ":***@"),
    confirmedOpenGames: confirmed.length, gaps: [],
  };

  for (const op of gaps) {
    const exerciseId = op.exerciseId;
    const bookingId = op.bookingId || op.upstreamBookingId;
    const exercise = (await fetchJson(`${vivaApiBase}/exercises/${encodeURIComponent(exerciseId)}`, { headers: auth })).payload;
    const roster = list((await fetchJson(
      `${vivaApiBase}/exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&size=200`,
      { headers: auth },
    )).payload);
    const rosterBooking = roster.find((item) => toStr(item.id) === bookingId) || null;
    const sameRoomGame = await games.findOne(
      { "booking.roomId": toStr(exercise?.room?.id), "metadata.source": "games_split_widget" },
      { sort: { createdAt: -1 }, projection: { "booking.masterServiceId": 1, "booking.subServiceIds": 1 } },
    );
    const services = sameRoomGame
      ? {
        masterServiceId: sameRoomGame.booking?.masterServiceId || null,
        subServiceIds: Array.isArray(sameRoomGame.booking?.subServiceIds) ? sameRoomGame.booking.subServiceIds : [],
      }
      : null;
    const shareAmountMinor = Number(op?.lk1?.target?.basePriceMinor) || null;
    const classification = classifyMissingGame({ exercise, rosterBooking, services, shareAmountMinor });

    const record = {
      operationKey: op._id, exerciseId, bookingId, actorClientId: op.actorClientId,
      serviceDate: op.serviceDate, studio: exercise?.studio?.name, room: exercise?.room?.name,
      timeFrom: exercise?.timeFrom, timeTo: exercise?.timeTo,
      paymentType: rosterBooking?.paymentType || null,
      classification, applied: null,
    };

    if (apply && classification.kind === GAP_REASONS.RESTORABLE) {
      const clientPayload = (await fetchJson(`${vivaApiBase}/clients/${encodeURIComponent(op.actorClientId)}`, { headers: auth })).payload;
      const payload = buildRestoredGamePayload({
        operation: op, exercise, client: clientPayload, rosterBooking, services, shareAmountMinor,
      });
      const response = await fetchJson(`${lkBase}/games`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }, 1);
      record.applied = { status: response.status, ok: response.ok, id: response.payload?.id || null };
      await sleep(500);
    }

    report.gaps.push(record);
  }

  const counters = report.gaps.reduce((acc, gap) => {
    acc[gap.classification.kind] = (acc[gap.classification.kind] || 0) + 1;
    return acc;
  }, {});
  report.counters = counters;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, gaps: report.gaps.length, counters, applied: report.gaps.filter((g) => g.applied).length }));
  await client.close();
  if (Object.keys(counters).some((key) => key !== GAP_REASONS.RESTORABLE)) {
    console.log("Non-restorable gaps require manual handling; see the report for reasons.");
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

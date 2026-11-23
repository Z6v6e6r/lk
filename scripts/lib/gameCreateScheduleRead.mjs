import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gameCreateServiceTable } from "./gameCreatePreparationSource.mjs";
import { extractSubscriptionPricePreviewSource } from "./subscriptionPricePreviewSources.mjs";

const vivaOrigin = "https://api.vivacrm.ru";
const lk1Origin = "https://padlhub.su";
const vivaUserPath = "/end-user/api/v1/iSkq6G";
const residencyProductId = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const tokenPattern = /^Bearer [A-Za-z\d._~-]{20,12000}$/;
const maximumResponseBytes = 524288;
const leadTimeSource = readFileSync(
  new URL("../../src/components/games/bookingLeadTime.ts", import.meta.url),
  "utf8",
);
const minimumLead = Number(
  leadTimeSource.match(
    /^export const GAME_BOOKING_MIN_LEAD_MINUTES = (\d+);$/m,
  )?.[1],
);
if (!Number.isInteger(minimumLead) || minimumLead <= 0)
  throw new Error("Booking lead time unavailable");
const { source: priceParser } = extractSubscriptionPricePreviewSource({
  source: readFileSync(
    new URL("../nodered_games_nodes/fn_split_router.js", import.meta.url),
    "utf8",
  ),
  label: "LK1 CREATE schedule court price",
  roots: ["extractExactCourtPrice"],
});
const extractExactCourtPrice = new Function(
  priceParser + "\nreturn extractExactCourtPrice;",
)();

export class GameCreateScheduleReadError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function upstreamUnavailable() {
  return new GameCreateScheduleReadError(
    503,
    "GAME_CREATE_SCHEDULE_UNAVAILABLE",
  );
}

function moscowLocal(instant) {
  return new Date(instant + 180 * 60000).toISOString().slice(0, 19) + "+03:00";
}

function minutesOfDay(value, day) {
  if (typeof value !== "string") return null;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::00(?:\.0{1,3})?)?$/.test(value))
    return +value.slice(0, 2) * 60 + +value.slice(3, 5);
  let local = value;
  if (value.length > 5 && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant) || instant % 60000 !== 0) return null;
    local = moscowLocal(instant).slice(0, 19);
  }
  if (
    local.length > 5 &&
    !new RegExp(`^${day}[T ]\\d{2}:\\d{2}(?::00(?:\\.0{1,3})?)?$`).test(local)
  )
    return null;
  const clock = local.length === 5 ? local : local.slice(11, 16);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) return null;
  return +clock.slice(0, 2) * 60 + +clock.slice(3);
}

function readRows(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") throw upstreamUnavailable();
  const arrays = keys.map((key) => payload[key]).filter(Array.isArray);
  if (arrays.length !== 1) throw upstreamUnavailable();
  return arrays[0];
}

function normalizeSlots(payload, day, startOfDay, duration, subServiceId, now) {
  const rows = readRows(payload, [
    "timeslots",
    "content",
    "data",
    "items",
    "result",
    "slots",
  ]).flat(2);
  if (rows.length > 2000) throw upstreamUnavailable();
  const slots = new Map();
  let observed = 0;
  for (const row of rows) {
    const roomId = row?.roomId ?? row?.resourceId ?? row?.room?.id;
    const roomName = row?.roomName ?? row?.resourceName ?? row?.room?.name;
    const from = minutesOfDay(
      row?.timeFrom ?? row?.dateTimeFrom ?? row?.time ?? row?.from,
      day,
    );
    const to = minutesOfDay(row?.timeTo ?? row?.dateTimeTo ?? row?.to, day);
    const explicitDuration = row?.durationMinutes ?? row?.duration?.minutes;
    const id = row?.id ?? row?.slotId ?? row?.timeSlotId;
    const subServiceIds = row?.subServiceIds;
    if (
      !uuid.test(roomId ?? "") ||
      typeof roomName !== "string" ||
      !roomName.trim() ||
      roomName.length > 160 ||
      from === null ||
      (row.date !== undefined &&
        (typeof row.date !== "string" || row.date.slice(0, 10) !== day)) ||
      (subServiceIds !== undefined &&
        (!Array.isArray(subServiceIds) ||
          !subServiceIds.includes(subServiceId)))
    )
      continue;
    const minutes = to === null ? explicitDuration : to - from;
    if (!Number.isInteger(minutes) || minutes <= 0) continue;
    observed++;
    if (
      minutes < duration ||
      from + duration >= 1440 ||
      row.available === false ||
      row.isAvailable === false
    )
      continue;
    const start = startOfDay + from * 60000;
    if (start < now + minimumLead * 60000) continue;
    const startsAt = moscowLocal(start);
    const endsAt = moscowLocal(start + duration * 60000);
    const key = createHash("sha256")
      .update(JSON.stringify([roomId, startsAt, endsAt]))
      .digest("hex");
    slots.set(key, {
      id: key,
      roomId,
      courtName: roomName.trim(),
      startsAt,
      endsAt,
      upstreamSlotId:
        typeof id === "string" && /^[A-Za-z\d._:-]{1,200}$/.test(id)
          ? id
          : null,
    });
  }
  if (rows.length > 0 && observed === 0) throw upstreamUnavailable();
  return [...slots.values()].sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      a.courtName.localeCompare(b.courtName, "ru"),
  );
}

async function readJson(
  fetchImpl,
  url,
  method,
  bearer,
  correlationId,
  signal,
  body,
) {
  const response = await fetchImpl(url, {
    method,
    redirect: "error",
    cache: "no-store",
    signal,
    headers: {
      Accept: "application/json",
      Authorization: bearer,
      "X-Correlation-ID": correlationId,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new GameCreateScheduleReadError(
        401,
        "GAME_CREATE_SCHEDULE_AUTH_REQUIRED",
      );
    throw upstreamUnavailable();
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumResponseBytes) throw upstreamUnavailable();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function currenciesMatchRuble(value) {
  if (!value || typeof value !== "object") return true;
  return (
    [value.currency, value.currencyCode].every(
      (currency) => currency === undefined || currency === "RUB",
    ) && Object.values(value).every(currenciesMatchRuble)
  );
}

function amountMinor(payload, subServiceId) {
  // The same fixed iSkq6G endpoint and branch of the exact LK1 split pricing parser use major RUB.
  if (!currenciesMatchRuble(payload)) return null;
  const major = extractExactCourtPrice(payload, [subServiceId]);
  if (major === null) return null;
  const amount = Math.round(major * 100);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000
    ? amount
    : null;
}

/** LK1 owns resolution of the service and the provider reads. The selection carries no caller price. */
export async function readGameCreateSchedule(
  { query, authorization, correlationId, signal },
  { fetchImpl = fetch, now = Date.now } = {},
) {
  if (!tokenPattern.test(authorization ?? ""))
    throw new GameCreateScheduleReadError(
      401,
      "GAME_CREATE_SCHEDULE_AUTH_REQUIRED",
    );
  const { stationId, day, durationMinutes, slotId } = query;
  const duration = Number(durationMinutes);
  const service = Object.hasOwn(gameCreateServiceTable, stationId)
    ? gameCreateServiceTable[stationId]
    : null;
  const timestamp = dayPattern.test(day ?? "")
    ? Date.parse(day + "T00:00:00+03:00")
    : NaN;
  if (
    !service ||
    !Number.isFinite(timestamp) ||
    moscowLocal(timestamp).slice(0, 10) !== day ||
    timestamp + 86400000 <= now() ||
    timestamp > now() + 14 * 86400000 ||
    ![60, 90, 120].includes(duration) ||
    (slotId !== undefined && !/^[a-f\d]{64}$/.test(slotId))
  )
    throw new GameCreateScheduleReadError(
      400,
      "GAME_CREATE_SCHEDULE_QUERY_INVALID",
    );

  const deadline = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const read = (url, method = "GET", body) =>
    readJson(
      fetchImpl,
      url,
      method,
      authorization,
      correlationId,
      combined,
      body,
    );
  try {
    const master =
      vivaOrigin +
      vivaUserPath +
      "/products/master-services/" +
      service.masterServiceId;
    const raw = await read(master + "/timeslots", "POST", {
      date: day,
      trainers: { type: "NO_TRAINER" },
      roomFormat: "FULL_ROOM",
      subServiceIds: [service.subServiceId],
    });
    const slots = normalizeSlots(
      raw,
      day,
      timestamp,
      duration,
      service.subServiceId,
      now(),
    );
    if (slotId === undefined) {
      return {
        slots: slots.map(({ id, roomId, courtName, startsAt, endsAt }) => ({
          id,
          roomId,
          courtName,
          startsAt,
          endsAt,
        })),
      };
    }
    const slot = slots.find((candidate) => candidate.id === slotId);
    if (!slot)
      throw new GameCreateScheduleReadError(
        409,
        "GAME_CREATE_SCHEDULE_SLOT_CHANGED",
      );
    const priceQuery = new URLSearchParams({
      studioId: stationId,
      roomId: slot.roomId,
      subServiceIds: service.subServiceId,
      fromDate: day,
      fromTime: slot.startsAt.slice(11, 19),
      toTime: slot.endsAt.slice(11, 19),
    });
    const wholeCourtMinor = amountMinor(
      await read(master + "/price?" + priceQuery),
      service.subServiceId,
    );
    if (wholeCourtMinor === null) throw upstreamUnavailable();
    const observedAt = now();
    let expiresAt = observedAt + 30000;
    const shareMinor = Math.round(wholeCourtMinor / 4);
    let residency = { status: "UNAVAILABLE" };
    try {
      const subscriptionsPayload = await read(
        vivaOrigin +
          vivaUserPath +
          "/subscriptions?includeFinished=false&size=100",
      );
      const subscriptions = readRows(subscriptionsPayload, [
        "subscriptions",
        "content",
        "items",
        "data",
      ]);
      const productIds = (entry) =>
        [
          entry?.productId,
          entry?.subscriptionProductId,
          entry?.product?.id,
          entry?.subscription?.id,
        ].filter((id) => uuid.test(id ?? ""));
      const activeResidency = subscriptions.filter((entry) =>
        productIds(entry).includes(residencyProductId),
      );
      if (
        activeResidency.length === 0 &&
        subscriptionsPayload?.last === true &&
        subscriptionsPayload?.totalElements === subscriptions.length &&
        subscriptions.every((entry) => productIds(entry).length > 0)
      ) {
        residency = { status: "NOT_APPLICABLE" };
      } else if (activeResidency.length === 1 && slot.upstreamSlotId) {
        const item = activeResidency[0];
        const subscriptionId = item.clientSubscriptionId ?? item.id;
        if (!uuid.test(subscriptionId ?? "")) throw upstreamUnavailable();
        const target = {
          targetKind: "NEW_GAME",
          slotId: slot.upstreamSlotId,
          stationId,
          roomId: slot.roomId,
          masterServiceId: service.masterServiceId,
          subServiceIds: [service.subServiceId],
          startsAt: slot.startsAt,
          durationMinutes: duration,
          shareCount: 4,
        };
        const result = await read(
          lk1Origin + "/lk/subscriptions/game-price-preview",
          "POST",
          {
            target,
            subscriptionIds: [subscriptionId],
          },
        );
        const [quote] =
          Array.isArray(result?.quotes) && result.quotes.length === 1
            ? result.quotes
            : [];
        const expected = JSON.stringify([
          target.slotId,
          stationId,
          target.roomId,
          target.masterServiceId,
          target.subServiceIds,
          target.startsAt,
          duration,
          4,
        ]);
        if (
          quote?.subscriptionId === subscriptionId &&
          quote.selectionKey === expected &&
          Number.isSafeInteger(quote.evaluatedAt) &&
          Number.isSafeInteger(quote.expiresAt) &&
          quote.evaluatedAt <= now() + 5000 &&
          quote.expiresAt > now() &&
          quote.expiresAt > quote.evaluatedAt &&
          quote.expiresAt - quote.evaluatedAt <= 60000 &&
          quote.basePriceMinor === shareMinor &&
          quote.freeMinutes === 0 &&
          quote.paidMinutes === duration &&
          quote.status === "AVAILABLE" &&
          quote.reasonCode == null &&
          Number.isSafeInteger(quote.amountMinor) &&
          quote.amountMinor > 0 &&
          quote.amountMinor < shareMinor
        ) {
          residency = { status: "APPLIED", amountMinor: quote.amountMinor };
          expiresAt = Math.min(expiresAt, quote.expiresAt);
        }
      }
    } catch {
      // Availability and the independently quoted base price remain visible.
    }
    if (expiresAt <= now()) throw upstreamUnavailable();
    return {
      wholeCourtMinor,
      shareMinor,
      residency,
      currency: "RUB",
      observedAt: new Date(observedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } catch (error) {
    if (error instanceof GameCreateScheduleReadError) throw error;
    throw upstreamUnavailable();
  }
}

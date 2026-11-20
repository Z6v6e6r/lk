import { createHash } from "node:crypto";

export class ClubError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unavailable = () => new ClubError(503, "VIVA_UNAVAILABLE", "VivaCRM временно недоступна.");
const uncertain = () => new ClubError(409, "BOOKING_UNCONFIRMED", "Бронь проверяется. Повторное бронирование этого времени пока заблокировано. Обратитесь в клуб.");
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuid = value => typeof value === "string" && idPattern.test(value);
const firstString = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim() || "";
const timeKey = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(value)
  ? Date.parse(value) : NaN;

export function createVivaClient(club, { fetcher = fetch } = {}) {
  const v1 = `/end-user/api/v1/${club.tenantKey}`;
  const v2 = `/end-user/api/v2/${club.tenantKey}`;
  const master = `/products/master-services/${club.masterServiceId}`;
  async function request(path, bearer, body) {
    let response;
    try {
      response = await fetcher(new URL(path, "https://api.vivacrm.ru"), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...(bearer ? { authorization: bearer } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(6500),
      });
      return { status: response.status, ok: response.ok, value: await response.json().catch(() => null) };
    } catch {
      throw unavailable();
    }
  }
  return {
    async profile(bearer) {
      if (typeof bearer !== "string" || bearer.length > 8000 || !/^Bearer [a-zA-Z0-9._~-]+$/.test(bearer)) {
        throw new ClubError(401, "AUTH_REQUIRED", "Войдите в личный кабинет.");
      }
      const result = await request(v1 + "/profile", bearer);
      if ([401, 403].includes(result.status)) throw new ClubError(401, "AUTH_REQUIRED", "Войдите в личный кабинет.");
      const user = result.value;
      if (!result.ok || !uuid(user?.id)) throw unavailable();
      return { id: user.id, name: firstString([user.firstName, user.lastName].filter(value => typeof value === "string").join(" "), "Игрок"), bearer };
    },
    async verifyOnSitePolicy(bearer) {
      const result = await request(v1 + master + "/meta", bearer);
      if (!result.ok || result.value?.id !== club.masterServiceId || result.value.onlinePaymentEnabled !== false) {
        throw new ClubError(503, "BOOKING_POLICY_UNVERIFIED", "Бронирование с оплатой на месте пока недоступно.");
      }
    },
    async startBooking(bearer, slot) {
      const operation = await request(v2 + master + "/booking", bearer, {
        subServiceIds: [slot.serviceId], studioId: club.stationId, roomId: slot.roomId,
        trainers: { type: "NO_TRAINER" }, paymentType: "ON_PLACE", comment: null,
        marketingAttribution: {}, timeFrom: slot.timeFrom, timeTo: slot.timeTo,
      });
      if (!operation.ok || !uuid(operation.value?.correlationId)) throw uncertain();
      return {
        correlationId: operation.value.correlationId,
        exerciseIds: Array.isArray(operation.value.exerciseIds) ? operation.value.exerciseIds.filter(uuid) : [],
      };
    },
    async readBooking(bearer, actorId, slot, operation, knownBooking = null) {
      const result = !knownBooking && operation?.correlationId
        ? await request(v2 + "/operations/" + operation.correlationId, bearer)
        : { ok: false, value: null };
      if (result.ok && result.value?.status === "FAILED") {
        throw new ClubError(409, "VIVA_BOOKING_REJECTED", "VivaCRM отклонила запись. Проверьте свободное время.");
      }
      const ids = new Set([
        ...(Array.isArray(result.value?.result?.bookingIds) ? result.value.result.bookingIds.filter(uuid) : []),
        ...(Array.isArray(result.value?.events) ? result.value.events
          .filter(event => (event?.action ?? event?.type) === "CREATE_BOOKING" && event.status === "COMPLETED").map(event => event.entityId).filter(uuid) : []),
      ]);
      if (knownBooking) ids.add(knownBooking.bookingId);

      const list = await request(v2 + "/bookings?size=100", bearer);
      const data = list.value;
      const rows = Array.isArray(data) ? data : data?.content;
      if (!list.ok || !Array.isArray(rows)) return null;
      const matches = rows.flatMap(booking => {
        const bookingId = firstString(booking?.id, booking?.bookingId);
        const exerciseId = firstString(booking?.exercise?.id, booking?.exerciseId);
        const bookingOwners = [
          booking?.client?.id, booking?.client?.clientId, booking?.clientId, booking?.playerId, booking?.userId,
        ].filter(owner => owner !== undefined);
        const station = firstString(booking?.exercise?.studio?.id, booking?.studio?.id, booking?.exercise?.studioId, booking?.studioId);
        const room = firstString(booking?.exercise?.room?.id, booking?.room?.id, booking?.exercise?.roomId, booking?.roomId);
        const start = firstString(booking?.exercise?.timeFrom, booking?.timeFrom, booking?.exercise?.startDateTime, booking?.from, booking?.startDateTime);
        const end = firstString(booking?.exercise?.timeTo, booking?.timeTo, booking?.exercise?.endDateTime, booking?.to, booking?.endDateTime);
        const operationProved = ids.has(bookingId) || operation?.exerciseIds?.includes(exerciseId);
        const recoveringBeforeAck = !operation?.correlationId && !knownBooking;
        if (!uuid(bookingId) || !uuid(exerciseId) || !(operationProved || recoveringBeforeAck)
          || (knownBooking && (bookingId !== knownBooking.bookingId || exerciseId !== knownBooking.exerciseId))
          || bookingOwners.some(owner => owner !== actorId) || station !== club.stationId || room !== slot.roomId
          || Date.parse(start) !== Date.parse(slot.timeFrom) || Date.parse(end) !== Date.parse(slot.timeTo)
          || booking.paymentType !== "ON_PLACE" || (booking.paymentMethod && booking.paymentMethod !== "ON_PLACE")
          || booking.transactionStatus != null || booking.clientSubscriptionId != null
          || (booking.pendingPayments !== undefined && (!Array.isArray(booking.pendingPayments) || booking.pendingPayments.length))
          || booking.isCancelled === true || booking.canceled === true || booking.cancelled === true
          || booking.cancellationDate || booking.cancelledAt || booking.exercise?.isCancelled || booking.exercise?.cancelled
          || booking.exercise?.canceled || booking.exercise?.archived
          || [booking.status, booking.bookingStatus, booking.exercise?.status, booking.exercise?.state]
            .some(status => /cancel|reject|archiv/i.test(String(status ?? "")))) return [];
        return [{ bookingId, exerciseId, room, station }];
      });
      return matches.length === 1 ? matches[0] : null;
    },
  };
}

export function validateBookingSlot(club, input, now = Date.now()) {
  const start = timeKey(input.timeFrom);
  const end = timeKey(input.timeTo);
  const duration = (end - start) / 60_000;
  const court = club.courts.find(item => item.id === input.roomId);
  const slotDate = typeof input.timeFrom === "string" ? input.timeFrom.slice(0, 10) : "";
  if (input.studioId !== club.stationId || !court
    || ![60, 90, 120].includes(duration) || !Number.isFinite(start)
    || slotDate < club.firstBookingDate || start < now + 15 * 60_000 || start > now + club.bookingDays * 86400_000) {
    throw new ClubError(422, "INVALID_SLOT", "Выберите доступный корт и время в Новокузнецке.");
  }
  return {
    roomId: court.id, roomName: court.name, serviceId: court.subServiceId,
    timeFrom: input.timeFrom, timeTo: input.timeTo, duration,
  };
}

export async function reserveCourt({ ledger, viva, club, actor, slot }) {
  const key = createHash("sha256").update(JSON.stringify([actor.id, slot.roomId, slot.timeFrom, slot.timeTo])).digest("hex");
  let row = await ledger.findOne({ _id: key, actorId: actor.id });
  if (row?.state === "REJECTED") {
    throw new ClubError(409, "VIVA_BOOKING_REJECTED", "VivaCRM отклонила запись. Выберите другое время.");
  }
  if (!row) {
    await viva.verifyOnSitePolicy(actor.bearer);
    try {
      await ledger.insertOne({ _id: key, actorId: actor.id, state: "SUBMITTED", slot, createdAt: new Date() });
    } catch (error) {
      if (error.code === 11000) throw uncertain();
      throw error;
    }
    const operation = await viva.startBooking(actor.bearer, slot);
    await ledger.updateOne({ _id: key }, { $set: { operation } });
    row = { operation };
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const booking = await viva.readBooking(actor.bearer, actor.id, slot, row.operation, row.booking);
      if (booking) {
        await ledger.updateOne({ _id: key }, { $set: { booking, state: "CONFIRMED", confirmedAt: new Date() } });
        return { ...booking, slot, key };
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    if (error.code === "VIVA_BOOKING_REJECTED") {
      await ledger.updateOne({ _id: key, state: "SUBMITTED" }, { $set: { state: "REJECTED" } });
      throw error;
    }
    if (!(error instanceof ClubError)) throw error;
  }
  throw uncertain();
}

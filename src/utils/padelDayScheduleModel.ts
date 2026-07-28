import type { Booking } from "./apiClient";

export const PADEL_DAY_DIRECTION_ID = 5245;
export const PADEL_DAY_TYPE_ID = 1279;
export const PADEL_DAY_PROD_DATE = "2026-07-29";
export const PADEL_DAY_DEV_DATE = "2026-07-26";
export const PADEL_DAY_SLOT_DURATION_MINUTES = 45;
export const PADEL_DAY_FIRST_SLOT_TIME = "08:00";
export const PADEL_DAY_LAST_SLOT_TIME = "20:00";

export type PadelDaySlot = {
  id: string;
  date: string;
  timeFrom: string;
  timeTo: string;
  timeKey: string;
  timeLabel: string;
  studioId: string;
  studioName: string;
  studioAddress: string | null;
  roomName: string | null;
  clientsCount: number;
  maxClientsCount: number;
  spotsLeft: number;
  isFull: boolean;
  isMine: boolean;
  bookingId: string | null;
  paymentUrl: string | null;
  raw: Record<string, unknown>;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickRecord(value: unknown, keys: string[]) {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    if (isRecord(value[key])) return value[key] as RecordValue;
  }
  return null;
}

function pickString(value: unknown, keys: string[]) {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]) {
  const candidate = pickString(value, keys);
  if (candidate == null) return null;
  const parsed = Number(candidate.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["content", "items", "data", "exercises", "results"]) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }
  return [];
}

function isoDate(value: unknown) {
  return String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
}

function clock(value: string) {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return value.match(/\d{2}:\d{2}/)?.[0] || "";
}

function toMinutes(clockValue: string) {
  const match = clockValue.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClockMinutes(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function isPadelDaySlotTime(timeKey: string) {
  const minutes = toMinutes(timeKey);
  const first = toMinutes(PADEL_DAY_FIRST_SLOT_TIME);
  const last = toMinutes(PADEL_DAY_LAST_SLOT_TIME);
  return minutes != null && first != null && last != null && minutes >= first && minutes <= last;
}

function directionId(value: unknown) {
  const direction = pickRecord(value, ["direction"]);
  return pickNumber(direction, ["id", "directionId"]) ?? pickNumber(value, ["directionId"]);
}

function typeId(value: unknown) {
  const type = pickRecord(value, ["type", "exerciseType"]);
  return pickNumber(type, ["id", "typeId"]) ?? pickNumber(value, ["typeId"]);
}

function isCancelled(value: RecordValue) {
  const status = String(pickString(value, ["status", "state"]) || "").toUpperCase();
  return value.isCancelled === true
    || value.cancelled === true
    || value.canceled === true
    || value.archived === true
    || status.includes("CANCEL")
    || status.includes("ARCHIVE");
}

function transactionIsTerminal(booking: Booking) {
  const transaction = String(booking.transactionStatus?.transactionStatus || "").toUpperCase();
  const card = String(booking.transactionStatus?.cardPaymentStatus?.status || "").toUpperCase();
  return [transaction, card].some((status) => (
    status.includes("FAILED")
    || status.includes("REFUND")
    || status.includes("CANCEL")
    || status.includes("EXPIRED")
  ));
}

export function isActivePadelDayBooking(booking: Booking, date: string) {
  return !booking.isCancelled
    && !transactionIsTerminal(booking)
    && directionId(booking.exercise) === PADEL_DAY_DIRECTION_ID
    && isoDate(booking.exercise?.timeFrom) === date;
}

export function findActivePadelDayBookings(bookings: Booking[], date: string) {
  return bookings.filter((booking) => isActivePadelDayBooking(booking, date));
}

export function normalizePadelDaySlots(
  payload: unknown,
  date: string,
  bookings: Booking[] = [],
): PadelDaySlot[] {
  const ownByExerciseId = new Map(
    findActivePadelDayBookings(bookings, date)
      .filter((booking) => booking.exercise?.id)
      .map((booking) => [booking.exercise!.id, booking]),
  );

  return extractItems(payload)
    .map((item): PadelDaySlot | null => {
      if (!isRecord(item) || isCancelled(item)) return null;
      if (directionId(item) !== PADEL_DAY_DIRECTION_ID || typeId(item) !== PADEL_DAY_TYPE_ID) return null;

      const id = pickString(item, ["id", "exerciseId", "uuid"]);
      const timeFrom = pickString(item, ["timeFrom", "startsAt", "startAt"]);
      const timeTo = pickString(item, ["timeTo", "endsAt", "endAt"]);
      if (!id || !timeFrom || !timeTo || isoDate(timeFrom) !== date) return null;

      const studio = pickRecord(item, ["studio", "station", "club"]);
      const room = pickRecord(item, ["room", "court"]);
      const studioId = pickString(studio, ["id", "studioId"]) || pickString(item, ["studioId"]);
      if (!studioId) return null;

      const clientsCount = Math.max(0, Math.floor(pickNumber(item, ["clientsCount", "participantsCount"]) || 0));
      const maxClientsCount = Math.max(0, Math.floor(pickNumber(item, ["maxClientsCount", "maxParticipants", "capacity"]) || 0));
      const spotsLeft = Math.max(0, maxClientsCount - clientsCount);
      const booking = ownByExerciseId.get(id) || null;
      const from = clock(timeFrom);
      const fromMinutes = toMinutes(from);
      if (!isPadelDaySlotTime(from) || fromMinutes == null) return null;
      const displayTo = formatClockMinutes(fromMinutes + PADEL_DAY_SLOT_DURATION_MINUTES);

      return {
        id,
        date,
        timeFrom,
        timeTo,
        timeKey: from,
        timeLabel: `${from}–${displayTo}`,
        studioId,
        studioName: pickString(studio, ["name", "title"]) || pickString(item, ["studioName"]) || "Станция",
        studioAddress: pickString(studio, ["address", "fullAddress"]) || pickString(item, ["studioAddress"]),
        roomName: pickString(room, ["name", "title"]) || pickString(item, ["roomName"]),
        clientsCount,
        maxClientsCount,
        spotsLeft,
        isFull: maxClientsCount > 0 && spotsLeft === 0,
        isMine: Boolean(booking),
        bookingId: booking?.id || null,
        paymentUrl: booking?.transactionStatus?.cardPaymentStatus?.paymentUrl || null,
        raw: item,
      };
    })
    .filter((slot): slot is PadelDaySlot => slot !== null)
    .sort((left, right) => (
      Date.parse(left.timeFrom) - Date.parse(right.timeFrom)
      || left.studioName.localeCompare(right.studioName, "ru")
    ));
}

export function getVisiblePadelDaySlots(
  slots: PadelDaySlot[],
  filters: { studioId: string | null; timeKeys: string[] },
) {
  return slots.filter((slot) => (
    (slot.spotsLeft > 0 || slot.isMine)
    && (!filters.studioId || slot.studioId === filters.studioId)
    && (filters.timeKeys.length === 0 || filters.timeKeys.includes(slot.timeKey))
  ));
}

export function hasSelectableSlot(slots: PadelDaySlot[], studioId?: string | null, timeKey?: string | null) {
  return slots.some((slot) => (
    (slot.spotsLeft > 0 || slot.isMine)
    && (!studioId || slot.studioId === studioId)
    && (!timeKey || slot.timeKey === timeKey)
  ));
}

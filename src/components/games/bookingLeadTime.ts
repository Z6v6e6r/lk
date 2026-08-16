export const GAME_BOOKING_MIN_LEAD_MINUTES = 120;

const MOSCOW_UTC_OFFSET = "+03:00";
const MINUTE_MS = 60_000;

export interface BookingLeadTimeCheck {
  ok: boolean;
  startTs: number | null;
  earliestStartTs: number;
}

export interface RevalidatedGameSlot {
  roomId: string;
  time: string;
  durationMinutes: number | null;
}

function normalizeDate(value: string): string | null {
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeTime(value: string): string | null {
  const normalized = value.trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized) ? normalized : null;
}

export function parseMoscowGameStart(date: string, time: string): number | null {
  const normalizedDate = normalizeDate(date);
  const normalizedTime = normalizeTime(time);
  if (!normalizedDate || !normalizedTime) return null;

  const parsed = Date.parse(`${normalizedDate}T${normalizedTime}:00${MOSCOW_UTC_OFFSET}`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function checkGameBookingLeadTime(
  date: string,
  time: string,
  nowTs = Date.now(),
  minLeadMinutes = GAME_BOOKING_MIN_LEAD_MINUTES,
): BookingLeadTimeCheck {
  const safeNowTs = Number.isFinite(nowTs) ? nowTs : Date.now();
  const safeMinLeadMinutes = Number.isFinite(minLeadMinutes)
    ? Math.max(0, minLeadMinutes)
    : GAME_BOOKING_MIN_LEAD_MINUTES;
  const earliestStartTs = safeNowTs + safeMinLeadMinutes * MINUTE_MS;
  const startTs = parseMoscowGameStart(date, time);

  return {
    ok: startTs !== null && startTs >= earliestStartTs,
    startTs,
    earliestStartTs,
  };
}

export function hasRevalidatedGameSlot(
  slots: RevalidatedGameSlot[],
  criteria: {
    roomId: string;
    time: string;
    durationMinutes: number;
  },
): boolean {
  return slots.some((slot) => (
    slot.roomId === criteria.roomId
    && slot.time === criteria.time
    && (slot.durationMinutes == null || slot.durationMinutes >= criteria.durationMinutes)
  ));
}

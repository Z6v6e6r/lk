// The club closing boundary is next-day midnight, while the tariff/service day
// remains the start date. This does not permit a general overnight interval.
export function bookingEndIso(
  date: string,
  fromTime: string,
  toTime: string,
  utcOffset: string,
): string {
  let endDate = date;
  if (/^00:00(?::00)?$/.test(toTime)
    && /^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(fromTime)
    && !/^00:00(?::00)?$/.test(fromTime)) {
    const day = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(day)) endDate = new Date(day + 86400000).toISOString().slice(0, 10);
  }
  return `${endDate}T${toTime}${toTime.length === 5 ? ":00" : ""}${utcOffset}`;
}

export function moscowBookingEndIso(date: string, fromTime: string, toTime: string): string {
  return bookingEndIso(date, fromTime, toTime, "+03:00");
}

type GameBookingTimes = {
  date?: string | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  timeFromIso?: string | null;
  timeToIso?: string | null;
  startTs?: number | null;
  endTs?: number | null;
};

function parseBookingInstant(value: string | null | undefined, utcOffset: string): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  const iso = value.replace(" ", "T");
  const ts = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + utcOffset);
  return Number.isFinite(ts) ? ts : null;
}

function parseStoredTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime())
    ? value
    : null;
}

export function resolveGameBookingTimes(
  booking: GameBookingTimes | null | undefined,
  utcOffset: string,
) {
  if (!booking) return { startTs: null, endTs: null };
  const { date, timeFrom, timeTo, timeFromIso, timeToIso } = booking;
  const startTs = parseBookingInstant(timeFromIso, utcOffset)
    ?? parseStoredTimestamp(booking.startTs)
    ?? parseBookingInstant(timeFrom, utcOffset)
    ?? (date && timeFrom
      ? parseBookingInstant(`${date}T${timeFrom}`, utcOffset)
      : null);

  // Old records may contain an end on the start date even for the closing slot.
  const endCandidates = [
    parseBookingInstant(timeToIso, utcOffset),
    parseStoredTimestamp(booking.endTs),
    parseBookingInstant(timeTo, utcOffset),
    date && timeTo ? parseBookingInstant(bookingEndIso(date, timeFrom || "", timeTo, utcOffset), utcOffset) : null,
  ];
  const endTs = endCandidates.find((candidate) => (
    candidate !== null && (startTs === null || candidate > startTs)
  )) ?? null;

  return { startTs, endTs };
}

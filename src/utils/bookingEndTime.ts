// The club closing boundary is next-day midnight, while the tariff/service day
// remains the start date. This does not permit a general overnight interval.
export function moscowBookingEndIso(date: string, fromTime: string, toTime: string): string {
  let endDate = date;
  if (/^00:00(?::00)?$/.test(toTime)
    && /^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(fromTime)
    && !/^00:00(?::00)?$/.test(fromTime)) {
    const day = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(day)) endDate = new Date(day + 86400000).toISOString().slice(0, 10);
  }
  return `${endDate}T${toTime}${toTime.length === 5 ? ":00" : ""}+03:00`;
}

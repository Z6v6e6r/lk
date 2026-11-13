export const PREVIEW_COURT_HOURLY_PRICE = 4000;

// Synthetic hourly tariff for the local game creation wizard.
export function previewCourtPrice(fromTime: unknown, toTime: unknown): number | null {
  const minutes = (time: unknown) => {
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const from = minutes(fromTime);
  const to = minutes(toTime);
  if (from == null || to == null || from === to) return null;
  const duration = (to - from + 1440) % 1440;
  return Math.round(PREVIEW_COURT_HOURLY_PRICE * duration / 60 * 100) / 100;
}

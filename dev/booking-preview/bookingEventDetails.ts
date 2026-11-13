import type { GamePaymentScope, ServiceKind } from './paymentMatrix';

export type BookingEventDetails = { date?: string | null; time?: string | null; location?: string | null };

// Date-only values stay in the event's calendar day, regardless of browser timezone.
export function bookingEventLines(details: BookingEventDetails | undefined, service: ServiceKind, scope?: GamePaymentScope) {
  const date = details?.date?.trim();
  let dateLabel = date;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const parsed = new Date(`${date}T12:00:00Z`);
    dateLabel = Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  }
  return {
    when: [dateLabel, details?.time?.trim()].filter(Boolean).join(' · ') || 'Дата и время уточняются',
    where: details?.location?.trim() || 'Место уточняется',
    scope: service === 'game' ? scope === 'court' ? 'Оплата всего корта' : scope === 'quarter' ? 'Моё участие · ¼ стоимости корта' : 'Формат оплаты уточняется' : 'Моё участие',
  };
}

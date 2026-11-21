import { bookingEventLines, type BookingEventDetails } from './bookingEventDetails';
import type { GamePaymentScope, ServiceKind } from './paymentMatrix';

export function PurchaseBookingEvent({ details, service, scope, name }: { details?: BookingEventDetails; service: ServiceKind; scope?: GamePaymentScope; name: string }) {
  const event = bookingEventLines(details, service, scope);
  return <details className="matrix-purchase-event-details">
    <summary>Ваша запись<span aria-hidden="true">⌄</span></summary>
    <div className="matrix-purchase-event matrix-purchase-game-card">
      <strong>{event.when}</strong>
      <span className="matrix-purchase-event-place">{event.station}</span>
      {service !== 'tournament' && <span>{details?.court?.trim() || 'Корт уточняется'}</span>}
      <strong>{name}</strong>
      <span className="matrix-purchase-event-scope">{event.scope}</span>
    </div>
  </details>;
}

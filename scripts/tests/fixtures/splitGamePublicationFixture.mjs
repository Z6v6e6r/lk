import { normalizePublicationIntent, normalizeBookingContract } from '../../lib/splitGamePublication.mjs';

export const publicationIntentFixture = () => ({ version: 1, settings: { isPrivate: true, ratingGame: false, minRating: null, maxRating: null },
  gameTitle: 'Fixture game', participantComment: 'Bring a racket', joinPrice: null,
  studioName: 'Fixture studio', roomName: 'Fixture court', gameFormat: 'doubles' });
export const publicationBookingContractFixture = () => normalizeBookingContract({ masterServiceId: 'fixture-master', subServiceIds: ['fixture-service'],
  shareAmountMinor: 250000, totalAmount: 10000, oneTimeBaseAmount: 10000, pricingPolicy: null, deadlineAt: null, assembleDeadlineAt: null });
export function makePublicationFixture() {
  const c = { timeFrom: '2030-11-12T18:00:00+03:00', timeTo: '2030-11-12T19:00:00+03:00', maxClientsCount: 4, roomId: 'fixture-room', trainers: [], requirements: [] };
  const intent = normalizePublicationIntent(publicationIntentFixture()), bookingContract = publicationBookingContractFixture();
  return { _id: 'fixture-operation-key', operationId: 'fixture-operation', tenantKey: 'fixture-tenant', actorClientId: 'fixture-actor',
    clientSubscriptionId: 'fixture-subscription', state: 'CONFIRMED', category: 'open_game',
    exerciseId: 'fixture-exercise', bookingId: 'fixture-booking', upstreamBookingId: 'fixture-booking', confirmedAt: '2030-11-12T10:00:00Z',
    lk1: { createPayload: c, target: { category: 'GAME', eventId: 'fixture-exercise', roomId: c.roomId, stationId: 'fixture-station', durationMinutes: 60, startsAt: c.timeFrom },
      decision: { benefit: { finalPriceMinor: 0 }, subscriptionVisitCount: 1 }, publication: { version: 1, state: 'PENDING', intent,
        intentJson: JSON.stringify(intent), actorClientId: 'fixture-actor', actorPhone: '79990000000', tenantKey: 'fixture-tenant',
        operationId: 'fixture-operation', createPayloadJson: JSON.stringify(c), bookingContract, bookingContractJson: JSON.stringify(bookingContract) } } };
}

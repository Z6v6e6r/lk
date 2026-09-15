// Synthetic exercise targets for the LK1 plan-rules acceptance matrix (line T).
// `resolveCategory` keys off Viva direction/type ids (see
// scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js):
// open game = direction 4588 / type 1613, group training = type 605,
// tournament = type 839. Times are far-future fixture dates, Moscow local.
export const STATION_ID = 'fixture-station-0001';
export const ROOM_ID = 'fixture-room-0001';

export const FIXTURE_SERVICE_DATE = '2099-09-20';
// Viva local wall clock; gateway adds the Moscow offset.
const openGameStartsAt = `${FIXTURE_SERVICE_DATE}T07:00:00`;

export const OPEN_GAME_60 = Object.freeze({
  id: 'fixture-exercise-open-60',
  studio: { id: STATION_ID },
  room: { id: ROOM_ID },
  typeId: 1613,
  directionId: 4588,
  name: 'Открытая игра',
  timeFrom: openGameStartsAt,
  timeTo: `${FIXTURE_SERVICE_DATE}T08:00:00`,
  durationMinutes: 60,
});

export const OPEN_GAME_90 = Object.freeze({
  ...OPEN_GAME_60,
  id: 'fixture-exercise-open-90',
  timeTo: `${FIXTURE_SERVICE_DATE}T08:30:00`,
  durationMinutes: 90,
});

export const GROUP_TRAINING_60 = Object.freeze({
  id: 'fixture-exercise-group-60',
  studio: { id: STATION_ID },
  room: { id: ROOM_ID },
  typeId: 605,
  directionId: 2617,
  name: 'Групповая тренировка',
  timeFrom: openGameStartsAt,
  timeTo: `${FIXTURE_SERVICE_DATE}T08:00:00`,
  durationMinutes: 60,
});

export const TOURNAMENT_60 = Object.freeze({
  id: 'fixture-exercise-tournament-60',
  studio: { id: STATION_ID },
  room: { id: ROOM_ID },
  typeId: 839,
  directionId: 2617,
  name: 'Турнир Americano',
  timeFrom: openGameStartsAt,
  timeTo: `${FIXTURE_SERVICE_DATE}T08:00:00`,
  durationMinutes: 60,
});

/** Moscow-local start instant the gateway re-validates the tariff proof against. */
export const startsAtMoscow = exercise => `${exercise.timeFrom}+03:00`;

/** A Viva one-time SERVICE tariff proof as observed by the gateway (<30 s old). */
export const tariffProof = ({ exercise, amountMinor }) => ({
  source: 'VIVA_EXISTING_TARIFF',
  amountMinor,
  stationId: exercise.studio.id,
  roomId: exercise.room.id,
  durationMinutes: exercise.durationMinutes,
  startsAt: startsAtMoscow(exercise),
  observedAt: Date.now(),
  kind: 'EVENT_ONE_TIME',
  productId: '5f0f0d1c-9a7e-4d3b-8c2a-000000000001',
});

/**
 * Prices in minor units. 60 min game = 600 ₽; 90 min = 900 ₽; the 90 min
 * fixture keeps the «60 free + 30 paid» split at 300 ₽ charge after 30 % off.
 */
export const PRICES = Object.freeze({
  OPEN_GAME_60: 60_000,
  OPEN_GAME_90: 90_000,
  GROUP_TRAINING_60: 300_000,
  TOURNAMENT_60: 300_000,
});

// Legacy CUP carrier price used by the pre-integration projection contract.
export const LEGACY_CARRIER_PRICE_MINOR = 1_000_000;

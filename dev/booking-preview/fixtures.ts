import { readMatrixSettings } from './paymentMatrix';
import { PREVIEW_COURT_HOURLY_PRICE, previewCourtPrice } from './gamePreviewPrice';
import { readPassRemaining } from './bookingCheckout';
import type { GameTimeSlot, PadelGamePlayer, PadelGameRecord, Studio, UserProfileType } from '../../src/utils/apiClient';
import type { GroupTrainingSummary } from '../../src/utils/groupScheduleApi';
import type { TournamentRegistrationState, TournamentSignupDetail, TournamentVivaCheckout, TournamentVivaProduct } from '../../src/utils/tournamentSignupApi';

export const scenario = new URLSearchParams(location.search).get('state') || 'ready';
let authenticated = scenario !== 'guest';
export function setDemoAuthenticated(value: boolean) { authenticated = value; }
export const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
export const eventDate = dateKey(tomorrow);
let trainingDate = eventDate;
let tournamentDate = eventDate;
export const profile: UserProfileType = {
  id: 'demo-viewer', firstName: 'Алексей', lastName: 'Тестовый', middleName: '',
  email: null, phone: '70000000001', sex: 'MALE', photo: null, birthDate: null,
  deposit: 0, trialUsed: false, withCard: false, loyaltyCard: '',
  clientCategory: { id: 0, name: 'Тестовый профиль' }, customFields: [],
};
export const studios: Studio[] = [
  { id: 'demo-seliger', name: 'Селигерская', country: 'Россия', city: 'Москва', address: 'Тестовая станция · Север Москвы', masterServiceId: 'demo-master', subServiceIds: ['demo-service'], preferredSubServiceId: 'demo-service' },
  { id: 'demo-terekhovo', name: 'Терехово', country: 'Россия', city: 'Москва', address: 'Тестовая станция · Запад Москвы', masterServiceId: 'demo-master', subServiceIds: ['demo-service'], preferredSubServiceId: 'demo-service' },
  { id: 'demo-luzhniki', name: 'Лужники', country: 'Россия', city: 'Москва', address: 'Тестовая станция · Центр Москвы', masterServiceId: 'demo-master', subServiceIds: ['demo-service'], preferredSubServiceId: 'demo-service' },
];
const demoPlayers: PadelGamePlayer[] = ['Михаил Игровой', 'Анна Падел', 'Иван Корт', 'Мария Ракетка'].map((name, index) => ({
  id: `demo-player-${index}`, name, phone: `7000000001${index}`, photo: null, rating: 'C', ratingNumeric: 2.5,
  source: index === 0 ? 'ORGANIZER' : 'INVITE_LINK', status: 'CONFIRMED',
}));
const viewer: PadelGamePlayer = { id: profile.id, name: `${profile.firstName} ${profile.lastName}`, phone: profile.phone, rating: 'C', status: 'CONFIRMED' };
let game: PadelGameRecord = {
  id: 'demo-game', status: 'PAID', inviteUrl: '/game_join?joinGame=demo-game', revision: 1,
  organizer: { ...demoPlayers[0], photo: null, rating: 'C' },
  settings: { ratingGame: false, minRating: 'D', maxRating: 'B', isPrivate: false, payMode: 'self' },
  participants: scenario === 'full' ? [...demoPlayers] : scenario === 'registered' ? [...demoPlayers.slice(0, 2), viewer] : demoPlayers.slice(0, 2),
  waitlist: [], invite: { maxPlayers: 4, waitlistEnabled: true },
  booking: { studioId: studios[0].id, studioName: studios[0].name, roomId: 'demo-court-1', roomName: 'Корт 1', date: eventDate, timeFrom: '19:00', timeTo: '20:30', durationMinutes: 90 },
  payment: { amount: 4000, paymentUrl: null, paid: true },
  metadata: { joinPrice: 1000 },
};
const registrations = new Map<string, boolean>();
function roster(count: number): PadelGamePlayer[] {
  return Array.from({ length: count }, (_, index) => ({ ...demoPlayers[index % demoPlayers.length], id: `demo-roster-${index}`, phone: `7000000${String(index + 1000).padStart(4, '0')}`, name: index < 4 ? demoPlayers[index].name : `Игрок ${index + 1}` }));
}
function registration(id: string): TournamentRegistrationState {
  const registered = registrations.get(id) ?? scenario === 'registered';
  return { status: registered ? 'REGISTERED' : 'NONE', bookingId: registered ? `demo-booking-${id}` : null,
    placeNumber: registered ? 3 : null, waitlistNumber: null, canRegister: !registered && scenario !== 'full',
    canCancel: registered, message: registered ? 'Вы записаны' : scenario === 'full' ? 'Свободных мест нет' : null };
}
function trainings(date = eventDate): GroupTrainingSummary[] {
  return ['Групповая тренировка', 'Игра + тренер', 'Тренировка для начинающих', 'Групповая тренировка без льгот'].map((title, index) => ({
    id: `demo-training-${index + 1}`, title, typeId: index === 1 ? 847 : 843,
    typeName: index === 1 ? 'Игра + тренер' : 'Групповая тренировка', typeColor: '#b6d87d',
    directionId: 100 + index, directionName: title,
    directionDescription: 'Разминка, работа над техникой ударов и игровая практика. Небольшая группа и внимание тренера каждому участнику.',
    whatToTake: 'Спортивная форма, чистая обувь и вода. Ракетку можно арендовать на станции.',
    timeFrom: `${date}T${index === 2 ? '20' : '18'}:00:00+03:00`, timeTo: `${date}T${index === 2 ? '21' : '19'}:30:00+03:00`,
    date, timeLabel: index === 2 ? '20:00–21:30' : '18:00–19:30',
    clientsCount: scenario === 'full' ? 4 : 2, maxClientsCount: 4, spotsLeft: scenario === 'full' ? 0 : 2,
    status: scenario === 'full' ? 'FULL' : 'AVAILABLE', girlsOnly: false,
    studioId: studios[index % studios.length].id, studioName: studios[index % studios.length].name,
    studioAddress: studios[index % studios.length].address, roomId: 'demo-court-1', roomName: 'Корт 1',
    trainers: [{ id: 'demo-coach', firstName: 'Андрей', lastName: 'Тренер' }], trainerName: 'Андрей Тренер', trainerAvatarUrl: null,
    levelLabel: index === 2 ? 'D / D+' : 'C / C+',
    inBooking: registration(`demo-training-${index + 1}`).status === 'REGISTERED', inWaitlist: false, inReserve: false,
    cancellationDeadline: null,
    raw: { id: `demo-training-${index + 1}`, title, previewPrivilegesExcluded: index === 3 || readMatrixSettings(new URLSearchParams(location.search)).excludedGroups, typeId: index === 1 ? 847 : 843, description: 'Тестовая тренировка', price: 5500, studioId: studios[index % studios.length].id },
  }));
}
function tournaments(date = eventDate): TournamentSignupDetail[] {
  return ['Американо · C / C+', 'Мексикано · D / D+', 'Парный турнир · B / B+'].map((title, index) => ({
    id: `demo-tournament-${index + 1}`, exerciseId: `demo-tournament-${index + 1}`, title,
    studioId: studios[index % studios.length].id, studioName: studios[index % studios.length].name, address: studios[index % studios.length].address,
    startsAt: `${date}T18:00:00+03:00`, endsAt: `${date}T21:00:00+03:00`, date, timeLabel: '18:00–21:00',
    genderLabel: 'Смешанный', format: index === 1 ? 'Мексикано' : 'Американо', levelLabel: index === 1 ? 'D / D+' : 'C / C+', priceLabel: '8 000 ₽',
    participantsCount: scenario === 'full' ? 16 : 10, maxParticipants: 16, waitlistCount: 0,
    status: registration(`demo-tournament-${index + 1}`).status === 'REGISTERED' ? 'REGISTERED' : scenario === 'full' ? 'FULL' : 'AVAILABLE',
    trainerName: 'Андрей Тренер', trainerAvatarUrl: null, publicUrl: null,
    storedPricingPreview: null, storedHasFriendlySubscriptionTag: false, storedSummerSubscriptionOffer: null,
    description: 'Турнир для тех, кто хочет больше игровой практики. Равные условия, смена партнёров и много интересных матчей.',
    rules: 'Разминка — 10 минут. Играем несколько раундов со сменой партнёров. Итоговое место определяется по сумме набранных очков.',
    registration: registration(`demo-tournament-${index + 1}`),
    raw: { id: `demo-tournament-${index + 1}`, name: title, price: 8000, participants: [...roster(scenario === 'full' ? 16 : 10), ...(registration(`demo-tournament-${index + 1}`).status === 'REGISTERED' ? [viewer] : [])], maxParticipants: 16, description: 'Игровая практика и дружеская атмосфера.' },
  }));
}
const pass: TournamentVivaProduct = {
  id: 'demo-subscription', name: 'Энергия 5', type: 'SUBSCRIPTION', cost: 0, visitsTotal: 5, source: 'client-subscription',
  raw: { name: 'Энергия 5', visitsLeft: 3, visitsTotal: 5, visitsUsed: 2, active: true, endDate: `${tomorrow.getFullYear() + 1}-12-31` },
};
const oneTime: TournamentVivaProduct = { id: 'demo-one-time', name: 'Разовое участие', type: 'SERVICE', cost: 550000, visitsTotal: null, source: 'one-time', raw: {} };
function checkout(id: string): TournamentVivaCheckout {
  const matrix = readMatrixSettings(new URLSearchParams(location.search));
  return { profile: authenticated ? profile : null, exercise: { id, name: 'Участие', studioId: studios[0].id }, studioId: studios[0].id,
    customPricing: null, purchasedProducts: [], clientSubscriptions: matrix.profile.pass && matrix.applicability.pass ? [{ ...pass, raw: { ...input(pass.raw), visitsLeft: readPassRemaining(new URLSearchParams(location.search)), visitsUsed: 5 - readPassRemaining(new URLSearchParams(location.search)) } }] : [], oneTimes: [{ ...oneTime, cost: id.includes('training') ? 550000 : 800000 }], subscriptions: [] };
}
const input = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const slots = (date: string): GameTimeSlot[] => [1, 2, 3].flatMap(court => ['09:00', '11:00', '14:00', '18:00', '19:00', '20:30', '22:00'].map(time => ({
  id: `demo-slot-${court}-${time}`, roomId: `demo-court-${court}`, roomName: `Корт ${court}`, date, time,
  price: PREVIEW_COURT_HOURLY_PRICE * 2, subServiceIds: ['demo-service'], durationMinutes: 120, timeTo: `${(Number(time.slice(0, 2)) + 2) % 24}`.padStart(2, '0') + `:${time.slice(3)}`,
})));

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  apiFetchProfile: () => profile,
  apiFetchOnboardingStations: () => studios,
  apiFetchPadelAvailableGames: (params) => ({ games: [{ ...game, booking: { ...game.booking, date: input(params).date || eventDate } }], total: 1, hasMore: false }),
  apiFetchPadelGamesByPhone: () => [],
  apiFetchPadelGameRecord: () => game,
  apiUpdatePadelGameRecord: (_id, patch) => { game = { ...game, ...input(patch) }; return game; },
  apiCreatePadelGameRecord: payload => { game = { ...game, ...input(payload), id: 'demo-created-game' }; return game; },
  apiCommandPadelGameRoster: (id, command) => {
    if (command === 'JOIN_WAITLIST') game = { ...game, waitlist: [viewer] };
    else game = { ...game, participants: [...(game.participants || []).filter(player => player.id !== viewer.id), viewer] };
    return { commandId: 'demo-command', replayed: false, relation: command === 'JOIN_WAITLIST' ? 'WAITLISTED' : 'PARTICIPANT', legacyGameId: id, canonicalGameId: id, aggregateRevision: 2, reservationId: null };
  },
  apiLeavePadelGameAsCurrentUser: () => { game = { ...game, participants: (game.participants || []).filter(player => player.id !== viewer.id), waitlist: [] }; return { game, status: 'LEFT' }; },
  apiPayMasterService: () => ({ paymentUrl: null, toPay: 0, bookingIds: ['demo-booking'], exerciseId: 'demo-exercise', paid: true }),
  apiFetchBookings: () => [], apiFetchSubscriptions: () => [], apiFetchSubscriptionDailyLimitBookings: () => [],
  apiFetchPadelChatsByPhone: () => ({ chats: [] }), apiFetchPadelGameResultState: () => ({ game }), apiFetchPadelLiveRatings: () => [], apiSearchPadelPlayers: () => demoPlayers,
  apiFetchSubscriptioName: () => ({ name: 'Энергия 5' }),
  apiFetchMasterServiceGameModes: () => ({ doubles: { key: 'doubles', subServiceIds: ['demo-service'], preferredSubServiceId: 'demo-service', preferredRoomIds: [] }, singles: null }),
  apiFetchMasterServiceTimeslots: date => slots(String(date)),
  apiFetchMasterServicePrice: params => previewCourtPrice(input(params).fromTime, input(params).toTime),
  apiFetchPadelSplitPaymentPromoConfig: () => ({ enabled: false, pricingMode: 'PER_PARTICIPANT_HOUR', currency: 'RUB', stationIds: [], stationNameIncludes: [], roomIds: [], roomNameIncludes: [], shareAmounts: { twoTeams: 2000, fourPlayers: 1000 }, baseShareAmount: 4000, vivaDirectionId: 4588, vivaExerciseTypeId: 1613 }),
  apiFetchGroupTrainingsByDate: date => { trainingDate = String(date); return trainings(trainingDate); },
  apiFetchGroupTrainingDetail: id => trainings(trainingDate).find(training => training.id === id) || trainings(trainingDate)[0],
  apiCheckTrialGroupEligibility: () => ({ eligible: true }),
  apiFetchTournamentSignupList: params => { tournamentDate = String(input(params).date || eventDate); return tournaments(tournamentDate); },
  apiFetchTournamentSignupDetail: id => tournaments(tournamentDate).find(tournament => tournament.id === id) || tournaments(tournamentDate)[0],
  apiFetchTournamentMyRegistration: id => registration(String(id)), apiFetchTournamentVivaMyRegistration: id => registration(String(id)),
  apiFetchTournamentVivaCheckout: id => checkout(String(id)), apiFetchTournamentVivaPublicCheckout: id => checkout(String(id)),
  apiFetchTournamentParticipants: id => {
    const count = String(id).includes('training') ? (scenario === 'full' ? 4 : 2) : (scenario === 'full' ? 16 : 10);
    const players = roster(count);
    if (registration(String(id)).status === 'REGISTERED') players.push(viewer);
    return { participants: players, participantsCount: players.length, waitlistCount: 0 };
  },
  apiFetchGroupSubscriptionDiscounts: () => ({ quotes: [] }), apiFetchTournamentSubscriptionDiscounts: () => ({ quotes: [] }),
  apiCreateTournamentVivaTransaction: params => {
    const id = String(input(params).exerciseId);
    registrations.set(id, true);
    return { paymentUrl: null, bookingId: `demo-booking-${id}`, toPay: 0, paid: true, paymentExpiresAt: null, raw: {} };
  },
  apiResolveTournamentVivaRegistrationBookingId: id => `demo-booking-${id}`,
  apiCancelTournamentVivaRegistration: () => { registrations.forEach((_value, id) => registrations.set(id, false)); return { cancelled: true }; },
  apiFetchCommunities: () => [],
};

export async function call(name: string, args: unknown[]) {
  if (scenario === 'loading') return new Promise<never>(() => {});
  await new Promise(resolve => setTimeout(resolve, 140));
  if (scenario === 'error') return { data: null, status: 503, error: { status: 503, message: 'Не удалось загрузить данные. Тестовое состояние ошибки.' } };
  if (scenario === 'empty' && /Fetch/.test(name) && name !== 'apiFetchProfile') {
    const data = /AvailableGames/.test(name) ? { games: [], total: 0, hasMore: false } : /ChatsByPhone/.test(name) ? { chats: [] }
      : /Detail|Record|Checkout|Registration/.test(name) ? null : [];
    return { data, error: null, status: 200 };
  }
  const handler = handlers[name];
  if (!handler) {
    console.warn(`[booking-preview] No fixture for ${name}`);
    return { data: null, status: 501, error: { status: 501, message: 'Этот шаг пока не настроен в локальном стенде.' } };
  }
  return { data: structuredClone(handler(...args)), error: null, status: 200 };
}

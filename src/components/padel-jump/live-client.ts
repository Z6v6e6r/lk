import { readAuthToken } from '../../utils/authTokenStorage';
import { LIVE_API, LIVE_ENGINE_VERSION, LIVE_RULE } from './live-contract';
import { createRaceTransport } from './race-connection';
import type { LiveAck, LiveTicket } from './race-connection';
export type { LiveAck, LiveTicket } from './race-connection';

export const LIVE_ERRORS: Record<string, string> = {
  IDENTITY_UNAVAILABLE: 'Сервис профиля или сообщества временно недоступен. Повтори проверку.', IDENTITY_RESPONSE_INVALID: 'Сервис вернул неполные данные профиля. Повтори проверку.', MEMBERSHIP_NOT_VERIFIED: 'Не удалось получить полный список участников. Повтори проверку; вступать заново не нужно.',
  PROFILE_INVALID: 'Сервис не подтвердил идентификатор профиля. Выйди и войди заново.', PROFILE_NAME_MISSING: 'В профиле и сообществе не указано имя. Проверь данные в личном кабинете.', IDENTITY_BUSY: 'Проверок сейчас много. Повтори чуть позже.',
  ENROLLMENT_INVALID: 'Проверь имя, фамилию, почту, сайт компании и согласие на сохранение анкеты.', ENROLLMENT_STORAGE_UNAVAILABLE: 'Не удалось сохранить анкету. Вступление не подтверждено; повтори проверку.', ENROLLMENT_UNAVAILABLE: 'Регистрация пока недоступна. Повтори чуть позже.',
  ENROLLMENT_JOIN_UNCONFIRMED: 'Анкета сохранена, но вступление пока не подтверждено. Нажми «Проверить ещё раз».', COMMUNITY_INVITE_UNAVAILABLE: 'Приглашение сообщества недоступно. Обратись к организатору.', ENROLLMENT_BUSY: 'Сейчас вступают другие участники. Повтори чуть позже.', ENROLLMENT_LIMIT: 'Лимит анкет достигнут. Обратись к организатору.',
  COMMUNITY_NOT_CONFIGURED: 'Заезды подключатся после создания сообщества.', PROFILE_AUTH_REQUIRED: 'Войди в личный кабинет и открой заезд из сообщества.', COMMUNITY_MEMBER_REQUIRED: 'Для участия вступи в сообщество мероприятия.', PROFILE_ALREADY_RUNNING: 'У этого профиля уже есть заезд. Вернись к нему или подожди отключения.',
  EVENT_FULL: 'На экране уже 12 участников. Попробуй чуть позже.', ALIAS_INVALID: 'Введи псевдоним до 24 символов без служебных знаков.',
  RULES_CHANGED: 'Правила обновились. Перезагрузи страницу.', RUN_ACCESS_DENIED: 'Заезд отключён или связь отсутствовала дольше 10 секунд. Начни новый заезд.',
  REPLAY_TOO_FAST: 'Сервер не подтвердил синхронизацию времени. Начни новый заезд.', SERVICE_UNAVAILABLE: 'Сервер заездов пока недоступен. Обычная игра продолжает работать.',
  INPUTS_NOT_RUNNING: 'Сервер уже остановил движение на этом участке. Начни новый заезд.', EXCESS_INPUTS: 'Движения после завершения участка не подтверждены. Начни новый заезд.', SEQUENCE_CONFLICT: 'Порядок обновлений заезда нарушился. Начни новый заезд.', CHECKPOINT_NOT_READY: 'Сервер ещё не подтвердил финиш участка.', RETRY_NOT_READY: 'Сервер ещё не подтвердил завершение попытки.', ALREADY_PAUSED: 'Заезд уже находится на паузе.', NOT_PAUSED: 'Пауза заезда не подтверждена.', RUN_FINISHED: 'Заезд уже завершён.',
};
export async function liveRequest<T>(path: string, body: unknown, signal: AbortSignal, token?: string): Promise<T> {
  const response = await fetch(LIVE_API + path, { method: 'POST', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json', ...(readAuthToken() ? { Authorization: 'Bearer ' + readAuthToken() } : {}), ...(token ? { 'X-Jump-Run-Token': token } : {}) }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: 'SERVICE_UNAVAILABLE' }));
  if (!response.ok || typeof data?.error === 'string') {
    const code = typeof data?.error === 'string' && /^[A-Z_]{1,64}$/.test(data.error) ? data.error : 'SERVICE_UNAVAILABLE';
    throw Object.assign(new Error((LIVE_ERRORS[code] ?? 'Не удалось подтвердить заезд.') + ` Код: ${code}.`), { status: response.status, code });
  }
  return data as T;
}

export function createRaceConnection(ticket: LiveTicket, ack: (v: LiveAck) => void, error: (message: string, retryFinish?: boolean) => void) {
  return createRaceTransport(ticket, ack, error, liveRequest<LiveAck>);
}
export async function joinRace(signal: AbortSignal): Promise<LiveTicket> {
  const ticket = await liveRequest<LiveTicket>('runs', { consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }, signal);
  if (ticket.engine !== LIVE_ENGINE_VERSION || ticket.rule !== LIVE_RULE || !/^[a-f0-9-]{36}$/.test(ticket.id) || !/^[a-f0-9]{64}$/.test(ticket.token) || ticket.seq !== 0 || ticket.player?.game?.campaign?.station !== 0) throw new Error('Сервер вернул другую версию заезда. Обнови страницу.');
  return ticket;
}

export async function raceProfile(signal: AbortSignal): Promise<{ id: string; name: string; communityId: string }> {
  const token = readAuthToken();
  const response = await fetch(LIVE_API + 'me', { signal, credentials: 'omit', headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const data = await response.json().catch(() => ({ error: 'SERVICE_UNAVAILABLE' }));
  if (!response.ok || typeof data.error === 'string') throw new Error(LIVE_ERRORS[data.error] ?? 'Не удалось подтвердить профиль сообщества.');
  if (typeof data.id !== 'string' || typeof data.name !== 'string' || typeof data.communityId !== 'string') throw new Error('Профиль не подтверждён.');
  return data;
}

export type RaceEntryStatus = { state: 'ready' | 'form' | 'pending' | 'blocked' | 'confirming'; name: string; communityName: string; fields?: { firstName: string; lastName: string; email: string; companyWebsite: string } };
export async function entryRequest<T>(path: 'entry' | 'enrollment', signal: AbortSignal, body?: unknown): Promise<T> {
  const token = readAuthToken();
  const response = await fetch(LIVE_API + path, { signal, credentials: 'omit', cache: 'no-store', method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({ error: 'SERVICE_UNAVAILABLE' }));
  if (!response.ok || typeof data.error === 'string') throw Object.assign(new Error(LIVE_ERRORS[data.error] ?? 'Не удалось проверить доступ к игре. Повтори проверку.'), { status: response.status });
  return data as T;
}

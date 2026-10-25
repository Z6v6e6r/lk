import { readAuthToken } from '../../utils/authTokenStorage';
import { LIVE_API, LIVE_ENGINE_VERSION, LIVE_RULE } from './live-contract';
import { createRaceTransport } from './race-connection';
import type { LiveAck, LiveTicket } from './race-connection';
export type { LiveAck, LiveTicket } from './race-connection';

export const LIVE_ERRORS: Record<string, string> = {
  COMMUNITY_NOT_CONFIGURED: 'Заезды подключатся после создания сообщества.', PROFILE_AUTH_REQUIRED: 'Войди в личный кабинет и открой заезд из сообщества.', COMMUNITY_MEMBER_REQUIRED: 'Для участия вступи в сообщество мероприятия.', PROFILE_ALREADY_RUNNING: 'У этого профиля уже есть заезд. Вернись к нему или подожди отключения.',
  EVENT_FULL: 'На экране уже 12 участников. Попробуй чуть позже.', ALIAS_INVALID: 'Введи псевдоним до 24 символов без служебных знаков.',
  RULES_CHANGED: 'Правила обновились. Перезагрузи страницу.', RUN_ACCESS_DENIED: 'Заезд отключён или связь отсутствовала дольше 10 секунд. Начни новый заезд.',
  REPLAY_TOO_FAST: 'Сервер не подтвердил синхронизацию времени. Начни новый заезд.', SERVICE_UNAVAILABLE: 'Сервер заездов пока недоступен. Обычная игра продолжает работать.',
};
export async function liveRequest<T>(path: string, body: unknown, signal: AbortSignal, token?: string): Promise<T> {
  const response = await fetch(LIVE_API + path, { method: 'POST', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json', ...(readAuthToken() ? { Authorization: 'Bearer ' + readAuthToken() } : {}), ...(token ? { 'X-Jump-Run-Token': token } : {}) }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: 'SERVICE_UNAVAILABLE' }));
  if (!response.ok || typeof data?.error === 'string') throw Object.assign(new Error(LIVE_ERRORS[data.error] ?? 'Не удалось подтвердить заезд. Повтори отправку.'), { status: response.status });
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

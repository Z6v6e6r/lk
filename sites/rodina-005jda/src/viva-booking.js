import { assertBinding } from './tenant-config.js';
// Public, read-only Viva API. This module never creates bookings or payments.
const API = 'https://api.vivacrm.ru';
let clockOffset = 0;
export const now = () => Date.now() + clockOffset;
export function moscowDay(timestamp = now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
export function addDays(day, count) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function bookingWindow(settings = {}, timestamp = now()) {
  const serverLimit = settings.maxBookingDaysAhead;
  const days = Number.isFinite(serverLimit) ? Math.max(0, Math.min(14, Math.floor(serverLimit))) : 14;
  const min = moscowDay(timestamp);
  return { min, max: addDays(min, days), end: Date.parse(`${addDays(min, days + 1)}T00:00:00+03:00`) };
}
export function validDay(day, settings, timestamp = now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false;
  const window = bookingWindow(settings, timestamp);
  return day >= window.min && day <= window.max && moscowDay(Date.parse(`${day}T12:00:00+03:00`)) === day;
}
export function durationMinutes(iso) {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
  return match ? Number(match[1] || 0) * 60 + Number(match[2] || 0) + Number(match[3] || 0) / 60 : 0;
}
export function timeLabel(iso) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
export function offsetISO(timestamp) {
  return new Date(timestamp + 3 * 3600000).toISOString().slice(0, 19) + '+03:00';
}
export function selectionValid(interval, minutes, settings, timestamp = now()) {
  const start = Date.parse(interval?.timeFrom), end = Date.parse(interval?.timeTo);
  const min = settings.minMinutes || 60;
  const step = settings.stepMinutes || 30;
  return Number.isFinite(start) && Number.isFinite(end) && start > timestamp && end > start &&
    validDay(moscowDay(start), settings, timestamp) && end <= bookingWindow(settings, timestamp).end &&
    minutes >= min && (minutes - min) % step === 0 && Math.abs((end - start) / 60000 - minutes) < .001;
}
export function intervalsFor(raw, binding, day, minutes, timestamp = now()) {
  if (!validDay(day, binding, timestamp) || minutes < binding.minMinutes) return [];
  const groups = raw?.byTrainer?.NO_TRAINER?.slots;
  if (!Array.isArray(groups)) return [];
  const slots = groups.flat().filter(slot => slot && slot.studioId === binding.studioId &&
    slot.roomId === binding.roomId && slot.subServiceId === binding.subServiceId && !slot.trainerId && !slot.roomPartGroupId &&
    Date.parse(slot.timeTo) > Date.parse(slot.timeFrom));
  const byStart = new Map();
  for (const slot of slots) {
    const start = Date.parse(slot.timeFrom);
    const existing = byStart.get(start);
    if (!existing || Date.parse(existing.timeTo) < Date.parse(slot.timeTo)) byStart.set(start, slot);
  }
  const result = [];
  for (const start of [...byStart.keys()].sort((a, b) => a - b)) {
    const first = byStart.get(start), end = start + minutes * 60000;
    if (moscowDay(start) !== day) continue;
    const interval = { timeFrom: first.timeFrom, timeTo: offsetISO(end) };
    if (!selectionValid(interval, minutes, binding, timestamp)) continue;
    const maxDuration = durationMinutes(first.availableDuration);
    if (first.availableDuration != null && maxDuration < minutes) continue;
    // Follow exact boundaries. Never bridge a missing or occupied half-hour.
    let cursor = start;
    while (cursor < end) {
      const slot = byStart.get(cursor);
      if (!slot) break;
      cursor = Math.min(end, Date.parse(slot.timeTo));
    }
    if (cursor === end) result.push(interval);
  }
  return result;
}
async function request(path, { body, signal, method } = {}) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(API + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, cache: 'no-store'
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много запросов. Попробуйте через минуту.' : 'Viva не смогла загрузить данные. Повторите попытку.');
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) throw new Error('Расписание отвечает слишком долго. Повторите попытку.');
    if (error instanceof TypeError) throw new Error('Не удалось связаться с расписанием. Проверьте интернет и повторите.');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', relay);
  }
}
function route(binding, version, suffix) {
  assertBinding(binding);
  return `/end-user/api/${version}/${encodeURIComponent(binding.tenantKey)}/products/master-services/${encodeURIComponent(binding.masterServiceId)}/${suffix}`;
}
export async function syncClock() {
  const before = Date.now();
  const data = await request('/api/v1/time?timeZone=UTC');
  const text = data.dateTime;
  const timestamp = Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(text) ? text : text + 'Z');
  if (!Number.isFinite(timestamp)) throw new Error('Не удалось определить текущее время.');
  clockOffset = timestamp - (before + Date.now()) / 2;
}
export async function settingsFor(binding, signal) {
  const meta = await request(route(binding, 'v1', 'meta'), { signal });
  if (meta.id !== binding.masterServiceId || meta.paused || !meta.roomRentEnabled) throw new Error('Запись на эту площадку временно недоступна.');
  return { ...binding, minMinutes: Math.max(Number(meta.minMinutesForBooking) || 0, durationMinutes(binding.serviceDuration), 1),
    stepMinutes: Number(meta.timeStepMinutes) || binding.stepMinutes || 30,
    maxBookingDaysAhead: meta.maxBookingDaysAhead, timeZone: meta.timeZone };
}
export function filterFor(binding, day) {
  return { date: day, studioId: binding.studioId, roomId: binding.roomId,
    subServiceIds: [binding.subServiceId], roomFormat: 'FULL_ROOM', trainers: { type: 'NO_TRAINER' } };
}
export async function slotsFor(binding, day, signal) {
  if (!validDay(day, binding)) throw new Error('Выберите дату в пределах ближайших двух недель.');
  return request(route(binding, 'v1', 'timeslots'), { body: filterFor(binding, day), signal });
}
export async function quoteFor(binding, interval, minutes, signal) {
  if (!selectionValid(interval, minutes, binding)) throw new Error('Выберите доступное время с учётом минимальной длительности и двух недель.');
  const validation = await request(route(binding, 'v1', 'timeslots/validate'), {
    body: { timeFrom: interval.timeFrom, timeTo: interval.timeTo, filter: filterFor(binding, moscowDay(Date.parse(interval.timeFrom))) }, signal
  });
  if (validation.available !== true) {
    const error = new Error('Это время уже недоступно. Выберите другой интервал.'); error.code = 'SLOT_UNAVAILABLE'; throw error;
  }
  const query = new URLSearchParams({ studioId: binding.studioId, roomId: binding.roomId, subServiceIds: binding.subServiceId,
    fromDate: moscowDay(Date.parse(interval.timeFrom)), toDate: moscowDay(Date.parse(interval.timeTo)),
    fromTime: timeLabel(interval.timeFrom), toTime: timeLabel(interval.timeTo) });
  const prices = await request(route(binding, 'v2', 'price?' + query), { signal });
  const price = prices?.[binding.subServiceId];
  // This endpoint returns major currency units (RUB), unlike subservice.priceFrom.
  const amount = price?.net ?? price?.from;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('Не удалось рассчитать стоимость этого времени. Выберите другой интервал или повторите.');
  if (!selectionValid(interval, minutes, binding)) throw new Error('Выбранное время уже прошло. Обновите расписание.');
  return { ...interval, amount, currency: 'RUB', minutes, checkedAt: now() };
}

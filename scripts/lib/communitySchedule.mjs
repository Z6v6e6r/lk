import { createVivaFetch } from './vivaUserAgent.mjs';
import { resolveExerciseCategoryFromValue } from '../../src/utils/exerciseCategory.ts';

/** Public schedule reads only. No roster/contact fields cross into projections. */
export async function loadCommunitySchedule({ nowIso, horizonDays = 14, fetchImpl = createVivaFetch() }) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 31) throw new Error('COMMUNITY_SCHEDULE_INVALID_HORIZON');
  const start = new Date(Date.parse(nowIso) + 3 * 3600000).toISOString().slice(0, 10);
  const rows = new Map();
  for (let day = 0; day < horizonDays; day++) {
    const date = new Date(Date.parse(start + 'T00:00:00Z') + day * 86400000).toISOString().slice(0, 10);
    const url = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/exercises?' + new URLSearchParams({ date });
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('COMMUNITY_SCHEDULE_UNAVAILABLE');
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : payload?.content ?? payload?.items ?? payload?.data;
    if (!Array.isArray(items) || items.length > 5000 || Number(payload?.totalPages) > 1) throw new Error('COMMUNITY_SCHEDULE_INCOMPLETE');
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) continue;
      const category = resolveExerciseCategoryFromValue(raw);
      const kind = category === 'tournament' ? 'TOURNAMENT' : 'EVENT';
      // Select fields explicitly. Public/provider responses may contain contacts.
      const pick = value => value && typeof value === 'object' ? { id: value.id, name: value.name } : undefined;
      rows.set(raw.id, { id: raw.id, title: raw.direction?.name || raw.type?.name || 'Событие',
        startsAt: raw.timeFrom, endsAt: raw.timeTo, studio: pick(raw.studio), room: pick(raw.room), direction: pick(raw.direction), type: pick(raw.type),
        clientsCount: raw.clientsCount, maxClientsCount: raw.maxClientsCount, category, kind,
        status: raw.status, isCancelled: raw.isCancelled === true || raw.cancelled === true || raw.canceled === true || raw.archived === true, source: 'VIVA_PUBLIC_SCHEDULE' });
    }
  }
  return [...rows.values()];
}

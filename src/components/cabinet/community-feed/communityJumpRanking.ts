import { readAuthToken } from '../../../utils/authTokenStorage';

// Owner-selected exhibition pilot. Other communities keep their existing provider.
export const JUMP_RANKING_COMMUNITY_ID = 'community_1793001495612_падлхаб-команда';
export const JUMP_GAME_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1';
export const JUMP_RANKING_V2_ACCEPT = 'application/vnd.padlhub.jump-community-ranking.v2+json';
const ENDPOINT = 'https://padlhub.su/jump-live-api/community-ranking';

export const usesJumpRanking = (id: string | null | undefined) => id === JUMP_RANKING_COMMUNITY_ID;
export function formatJumpRankingTime(value: number) {
  const tenths = Math.floor(Math.max(0, value) / 100);
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}
export type CommunityJumpRankingRow = { id: string; rank: number; name: string; stars: number; elapsedMs: number; isCurrentUser: boolean };
export type CommunityJumpRanking = { schema: 'jump-community-ranking-v1' | 'jump-community-ranking-v2'; communityId: string; rule: string; lives: number; retentionHours: number | null; total: number; rows: CommunityJumpRankingRow[]; me: CommunityJumpRankingRow | null };

export function parseCommunityJumpRanking(raw: string, communityId: string): CommunityJumpRanking {
  if (raw.length > 262144) throw new Error('Несовместимый ответ рейтинга Jump.');
  let data: CommunityJumpRanking;
  try { data = JSON.parse(raw) as CommunityJumpRanking; } catch { throw new Error('Несовместимый ответ рейтинга Jump.'); }
  if (!data || typeof data !== 'object') throw new Error('Несовместимый ответ рейтинга Jump.');
  const valid = (row: CommunityJumpRankingRow) => row && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id) && Number.isInteger(row.rank) && row.rank > 0 && row.rank <= data.total
    && typeof row.name === 'string' && [...row.name].length > 0 && [...row.name].length <= 48 && !/[\p{C}<>]/u.test(row.name)
    && Number.isSafeInteger(row.stars) && row.stars >= 0 && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && typeof row.isCurrentUser === 'boolean';
  const legacy = data.schema === 'jump-community-ranking-v1';
  if ((!legacy && data.schema !== 'jump-community-ranking-v2') || data.communityId !== communityId || typeof data.rule !== 'string' || !data.rule
    || !Number.isInteger(data.lives) || data.lives < 1 || (legacy ? data.retentionHours !== 48 : data.retentionHours !== null)
    || !Number.isSafeInteger(data.total) || data.total < 0 || legacy && data.total > 500 || !Array.isArray(data.rows) || data.rows.length !== Math.min(100, data.total)
    || data.rows.some((row, index) => !valid(row) || row.rank !== index + 1)
    || new Set(data.rows.map(row => row.id)).size !== data.rows.length || data.rows.filter(row => row.isCurrentUser).length > 1
    || data.me !== null && (!valid(data.me) || !data.me.isCurrentUser)) throw new Error('Несовместимый ответ рейтинга Jump.');
  for (let n = 1; n < data.rows.length; n++) {
    const a = data.rows[n - 1], b = data.rows[n];
    if (a.stars < b.stars || a.stars === b.stars && a.elapsedMs > b.elapsedMs) throw new Error('Несовместимый порядок рейтинга Jump.');
  }
  const visibleMe = data.rows.find(row => row.isCurrentUser);
  if (visibleMe && (!data.me || visibleMe.id !== data.me.id || visibleMe.rank !== data.me.rank || visibleMe.stars !== data.me.stars || visibleMe.elapsedMs !== data.me.elapsedMs || visibleMe.name !== data.me.name)
    || data.me && data.me.rank <= data.rows.length && !visibleMe) throw new Error('Несовместимая позиция профиля в рейтинге Jump.');
  const clean = ({ id, rank, name, stars, elapsedMs, isCurrentUser }: CommunityJumpRankingRow) => ({ id, rank, name, stars, elapsedMs, isCurrentUser });
  return { schema: data.schema, communityId: data.communityId, rule: data.rule, lives: data.lives, retentionHours: data.retentionHours, total: data.total, rows: data.rows.map(clean), me: data.me ? clean(data.me) : null };
}

export async function fetchCommunityJumpRanking(communityId: string, signal: AbortSignal, options: { fetcher?: typeof fetch; token?: string } = {}): Promise<CommunityJumpRanking> {
  if (!usesJumpRanking(communityId)) throw new Error('Рейтинг Jump не подключён к этому сообществу.');
  const token = options.token ?? readAuthToken();
  if (!token) throw Object.assign(new Error('Войди в профиль ПадлхАБ, чтобы увидеть рейтинг Jump.'), { status: 401 });
  const url = new URL(ENDPOINT); url.searchParams.set('communityId', communityId);
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
  try {
    const response = await (options.fetcher ?? fetch)(url.href, { method: 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer ' + token, Accept: JUMP_RANKING_V2_ACCEPT } });
    if (!response.ok) {
      const message = response.status === 401 ? 'Войди в профиль ПадлхАБ, чтобы увидеть рейтинг Jump.' : response.status === 403 ? 'Рейтинг Jump доступен участникам сообщества.' : 'Не удалось загрузить рейтинг Jump. Повтори обновление.';
      throw Object.assign(new Error(message), { status: response.status });
    }
    return parseCommunityJumpRanking(await response.text(), communityId);
  } catch (error) {
    if (timedOut) throw new Error('Рейтинг Jump не ответил вовремя. Повтори обновление.');
    if (signal.aborted || error && typeof error === 'object' && 'status' in error) throw error;
    throw new Error('Не удалось загрузить рейтинг Jump. Повтори обновление.');
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}

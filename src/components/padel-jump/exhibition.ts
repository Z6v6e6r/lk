/** Owner-selected November pilot only. The backend, never this route flag, grants admission. */
export const EXHIBITION_COMMUNITY_ID = 'community_1794221739126_корпспорт-падлхаб-2026';
export const EXHIBITION_GAME_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1&jumpExhibition=1';
export const EXHIBITION_LIVE_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpLive=1&jumpExhibition=1';
/** Second exhibition game hub, reachable from the jump start screen. */
export const PADEL_GAME_HUB_URL = 'https://padlhub.su/padel/';
export const isExhibitionRoute = (search = typeof window === 'undefined' ? '' : window.location.search) => new URLSearchParams(search).get('jumpExhibition') === '1'
  || typeof window !== 'undefined' && /^\/lk\/padel-jump-exhibition-[a-f0-9]{8}\//.test(window.location.pathname);
export const exhibitionApi = (origin = typeof window === 'undefined' ? '' : window.location.origin) => origin === 'https://padlhub.ru' ? 'https://padlhub.su/jump-exhibition-api/' : '/jump-exhibition-api/';

/** Fixed cabinet destination: the exhibition game returns to its community, never the public wall. */
export const EXHIBITION_CABINET_URL = 'https://padlhub.ru/lk_new?authMode=viva';
export function exhibitionCommunityUrl(communityId?: string | null): string {
  const id = String(communityId || EXHIBITION_COMMUNITY_ID).trim();
  return id ? `${EXHIBITION_CABINET_URL}&openCommunity=${encodeURIComponent(id)}` : EXHIBITION_CABINET_URL;
}

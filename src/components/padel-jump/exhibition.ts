/** Owner-selected November pilot only. The backend, never this route flag, grants admission. */
export const EXHIBITION_COMMUNITY_ID = 'community_1794221739126_корпспорт-падлхаб-2026';
export const EXHIBITION_GAME_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1&jumpExhibition=1';
export const EXHIBITION_LIVE_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpLive=1&jumpExhibition=1';
export const isExhibitionRoute = (search = typeof window === 'undefined' ? '' : window.location.search) => new URLSearchParams(search).get('jumpExhibition') === '1';
export const exhibitionApi = (origin = typeof window === 'undefined' ? '' : window.location.origin) => origin === 'https://padlhub.ru' ? 'https://padlhub.su/jump-exhibition-api/' : '/jump-exhibition-api/';

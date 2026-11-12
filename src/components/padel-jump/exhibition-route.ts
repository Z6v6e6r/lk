/** KorpSport exhibition routes and public URLs. Brand assets stay out so navigation can use this module alone. */
export const EXHIBITION_CABINET_URL = 'https://padlhub.ru/lk_new?authMode=viva';
export const EXHIBITION_GAME_URL = `${EXHIBITION_CABINET_URL}&padelJumpRace=1&jumpExhibition=1`;
export const EXHIBITION_PRACTICE_URL = `${EXHIBITION_CABINET_URL}&padelJump=1&jumpExhibition=1`;
export const EXHIBITION_LIVE_URL = `${EXHIBITION_CABINET_URL}&padelJumpLive=1&jumpExhibition=1`;

/** True while the cabinet runs the exhibition widget, including its immutable standalone URL. */
export const isExhibitionRoute = (search = typeof window === 'undefined' ? '' : window.location.search) => new URLSearchParams(search).get('jumpExhibition') === '1'
  || typeof window !== 'undefined' && /^\/lk\/padel-jump-exhibition-[a-f0-9]{8}\//.test(window.location.pathname);

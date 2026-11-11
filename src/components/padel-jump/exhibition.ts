/** Owner-selected November pilot only. The backend, never this route flag, grants admission. */
export const EXHIBITION_COMMUNITY_ID = 'community_1794221739126_корпспорт-падлхаб-2026';
/** Public Tilda invite slug. It only selects presentation: admission stays server-side. */
export const EXHIBITION_INVITE_SLUG = 'корпспорт-падлхаб-2026-vokxwv';
export const EXHIBITION_INVITE_HEADING = 'Вступай в сообщество КорпСпорт 2026';
export const EXHIBITION_INVITE_NOTE = 'Все участники выставки КорпСпорт 2026.';
export const EXHIBITION_GAME_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1&jumpExhibition=1';
export const EXHIBITION_LIVE_URL = 'https://padlhub.ru/lk_new?authMode=viva&padelJumpLive=1&jumpExhibition=1';
export const isExhibitionRoute = (search = typeof window === 'undefined' ? '' : window.location.search) => new URLSearchParams(search).get('jumpExhibition') === '1'
  || typeof window !== 'undefined' && /^\/lk\/padel-jump-exhibition-[a-f0-9]{8}\//.test(window.location.pathname);
/** Public page override for the guest hero: a community logo/title the Tilda owner can pass in the URL. */
export function readExhibitionBrandOverride(search = typeof window === "undefined" ? "" : window.location.search): {
  readonly logoUrl?: string;
  readonly heading?: string;
} {
  const params = new URLSearchParams(search);
  const logo = (params.get("brandLogo") || params.get("logo") || "").trim();
  const heading = (params.get("brandTitle") || "").trim();
  const safeLogo = /^(?:https:\/\/|\/(?!\/))/i.test(logo) && logo.length <= 2000 ? logo : undefined;
  const safeHeading = heading && heading.length <= 120 ? heading : undefined;
  return { ...(safeLogo ? { logoUrl: safeLogo } : {}), ...(safeHeading ? { heading: safeHeading } : {}) };
}

export const isExhibitionInvite = (inviteCode?: string | null) => {
  const normalized = String(inviteCode || '').trim().toLowerCase();
  return Boolean(normalized) && normalized === EXHIBITION_INVITE_SLUG.toLowerCase();
};
export const exhibitionApi = (origin = typeof window === 'undefined' ? '' : window.location.origin) => origin === 'https://padlhub.ru' ? 'https://padlhub.su/jump-exhibition-api/' : '/jump-exhibition-api/';

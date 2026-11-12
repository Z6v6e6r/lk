import { EXHIBITION_GAME_URL, EXHIBITION_LIVE_URL, EXHIBITION_PRACTICE_URL, isExhibitionRoute } from './exhibition-route.ts';

type RacePage = 'race' | 'practice' | 'live';

const TEAM_LIVE_URL = 'https://padlhub.su/lk/padel-jump-team-60816487/padel-jump-live.html';

/** Fixed public destinations only; never carry the current query or session data. */
export function racePageUrl(
  page: RacePage,
  origin = typeof window === 'undefined' ? '' : window.location.origin,
  exhibition = isExhibitionRoute(),
): string {
  if (origin === 'https://padlhub.ru') {
    // Keeping jumpExhibition=1 is what selects the exhibition widget; without it the cabinet
    // falls back to the older team game and its links leave the exhibition flow.
    if (exhibition) return page === 'race' ? EXHIBITION_GAME_URL : page === 'practice' ? EXHIBITION_PRACTICE_URL : EXHIBITION_LIVE_URL;
    if (page === 'live') return TEAM_LIVE_URL;
    return `https://padlhub.ru/lk_new?authMode=viva&${page === 'race' ? 'padelJumpRace' : 'padelJump'}=1`;
  }
  return page === 'race' ? './padel-jump-race.html' : page === 'live' ? './padel-jump-live.html' : './padel-jump.html';
}

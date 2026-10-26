type RacePage = 'race' | 'practice' | 'live';

/** Fixed public destinations only; never carry the current query or session data. */
export function racePageUrl(page: RacePage, origin = typeof window === 'undefined' ? '' : window.location.origin): string {
  if (origin === 'https://padlhub.ru') {
    if (page === 'live') return 'https://padlhub.su/lk/padel-jump-team-60816487/padel-jump-live.html';
    return `https://padlhub.ru/lk_new?authMode=viva&${page === 'race' ? 'padelJumpRace' : 'padelJump'}=1`;
  }
  return page === 'race' ? './padel-jump-race.html' : page === 'live' ? './padel-jump-live.html' : './padel-jump.html';
}

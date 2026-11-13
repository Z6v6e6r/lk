export function previewScreenForUrl(raw: string, current: string) {
  const url = new URL(raw, 'https://preview.invalid');
  if (url.pathname.includes('game_join') || url.searchParams.has('joinGame')) return 'game-join';
  if (url.pathname.includes('game_create')) return 'game-booking';
  if (url.pathname.includes('group')) return 'training-join';
  if (url.pathname.includes('tournament')) return 'tournament-join';
  if (url.pathname.includes('lk_new') || url.pathname.includes('finde_game')) return 'game-list';
  return current;
}

export function navigatePreview(raw: unknown) {
  if (typeof raw !== 'string') return null;
  const target = new URL(location.href);
  const current = target.searchParams.get('screen') || 'game-list';
  const next = previewScreenForUrl(raw, current);
  if (next !== current) {
    target.searchParams.set('screen', next);
    location.assign(target.href);
  }
  return null;
}

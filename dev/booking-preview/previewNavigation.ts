export function previewScreenForUrl(raw: string, current: string) {
  const url = new URL(raw, 'https://preview.invalid');
  if (url.pathname.includes('game_join') || url.searchParams.has('joinGame')) return 'game-join';
  if (url.pathname.includes('game_create')) return 'game-booking';
  if (url.pathname.includes('group')) return 'training-join';
  if (url.pathname.includes('tournament')) return 'tournament-join';
  if (url.pathname.includes('lk_new') || url.pathname.includes('finde_game')) return 'game-list';
  return current;
}

export function previewNavigationUrl(raw: string, currentUrl: string): string | null {
  const target = new URL(currentUrl);
  const incoming = new URL(raw, target);
  const current = target.searchParams.get('screen') || 'game-list';
  const next = previewScreenForUrl(raw, current);
  if (next === current && !incoming.searchParams.has('joinGame') && !incoming.searchParams.has('exerciseId')) return null;
  target.searchParams.set('screen', next);
  target.searchParams.delete('eventId');
  target.searchParams.delete('date');
  const id = incoming.searchParams.get('joinGame') || incoming.searchParams.get('exerciseId') || incoming.searchParams.get('groupExerciseId');
  const date = incoming.searchParams.get('date');
  if (id && /^demo-(game|training-[1-4]|tournament-[1-3])$/.test(id)) target.searchParams.set('eventId', id);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))) target.searchParams.set('date', date);
  return target.href;
}

export function navigatePreview(raw: unknown) {
  if (typeof raw !== 'string') return null;
  const target = previewNavigationUrl(raw, location.href);
  if (target) location.assign(target);
  return null;
}

export function previewScheduleUrl(currentUrl: string) {
  const target = new URL(currentUrl);
  const screen = target.searchParams.get('screen') || '';
  target.searchParams.set('screen', screen.startsWith('training') ? 'training-booking' : screen.startsWith('tournament') ? 'tournament-booking' : 'game-list');
  target.searchParams.set('state', 'ready');
  target.searchParams.delete('eventId');
  const date = target.searchParams.get('date');
  if (target.searchParams.get('screen') === 'game-list' && date) target.searchParams.set('atlasDate', date);
  return target.href;
}

const routeFields = ['screen', 'eventId', 'date', 'state', 'atlasDate', 'atlasCategory', 'atlasAudience', 'atlasFormat', 'atlasKind', 'atlasLevel', 'atlasPlaces', 'atlasSearch', 'atlasStation', 'atlasStatus', 'atlasTime'] as const;
export function copyPreviewRoute(base: URLSearchParams, active: URLSearchParams) {
  const shared = new URLSearchParams(base);
  for (const key of routeFields) {
    shared.delete(key);
    for (const value of active.getAll(key)) shared.append(key, value);
  }
  return shared;
}

import { BALANCE, sectionKey, STATIONS } from './campaign.ts';
import type { Game } from './engine';

export const PROGRESS_KEY = 'padlhub.jump.campaign.v1';
export type PartResult = { done: boolean; clean: boolean; perfect: boolean; bestStars: number; failures: number };
export type Progress = {
  schema: 1; balance: number; unsupported?: boolean; unlocked: number; current: { station: number; section: number };
  parts: Record<string, PartResult>; claimed: string[]; completed: boolean; tutorial: boolean;
  settings: { assist: boolean; effects: boolean; journal: boolean }; activeSeconds: number;
};
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const emptyPart = (): PartResult => ({ done: false, clean: false, perfect: false, bestStars: 0, failures: 0 });
export function freshProgress(): Progress {
  return { schema: 1, balance: BALANCE.version, unlocked: 0, current: { station: 0, section: 0 }, parts: {}, claimed: [],
    completed: false, tutorial: false, settings: { assist: false, effects: true, journal: true }, activeSeconds: 0 };
}
function frontier(progress: Progress) {
  progress.unlocked = 0; progress.completed = true;
  for (let station = 0; station < STATIONS.length; station++) for (let section = 0; section < 3; section++) {
    if (!progress.parts[sectionKey(station, section)]?.done) {
      progress.current = { station, section }; progress.unlocked = station; progress.completed = false; return;
    }
  }
  progress.unlocked = STATIONS.length - 1; progress.current = { station: STATIONS.length - 1, section: 2 };
}
export function loadProgress(storage?: Pick<Storage, 'getItem'>): Progress {
  const p = freshProgress();
  try {
    const raw = storage?.getItem(PROGRESS_KEY);
    if (!raw) return p;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return p;
    const v = value as Record<string, unknown>;
    // Unknown future schemas are not overwritten on load; V1 always restores coherent section starts.
    if ((typeof v.schema === 'number' && v.schema > 1) || (typeof v.balance === 'number' && v.balance > BALANCE.version)) { p.unsupported = true; return p; }
    if (v.schema !== 1) return p;
    if (v.parts && typeof v.parts === 'object') for (let s = 0; s < STATIONS.length; s++) for (let n = 0; n < 3; n++) {
      const key = sectionKey(s, n), part = (v.parts as Record<string, unknown>)[key];
      if (!part || typeof part !== 'object') continue;
      const a = part as Record<string, unknown>;
      p.parts[key] = { done: a.done === true, clean: a.clean === true, perfect: a.perfect === true,
        bestStars: integer(a.bestStars, 100), failures: integer(a.failures, 9999) };
    }
    // Do not trust unlocked/current flags independently of completed checkpoints.
    frontier(p);
    if (Array.isArray(v.claimed)) p.claimed = [...new Set(v.claimed.filter((x): x is string => typeof x === 'string' && /^\d{1,2}:[0-2]:\d{1,3}$/.test(x)))].slice(0, 2000);
    if (v.settings && typeof v.settings === 'object') {
      const a = v.settings as Record<string, unknown>;
      p.settings = { assist: a.assist === true, effects: a.effects !== false, journal: a.journal !== false };
    }
    p.tutorial = v.tutorial === true; p.activeSeconds = typeof v.activeSeconds === 'number' && Number.isFinite(v.activeSeconds) ? Math.max(0, Math.min(v.activeSeconds, 1e8)) : 0;
    return p;
  } catch { return p; }
}
function integer(v: unknown, cap: number) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, cap) : 0; }
export function writeProgress(progress: Progress, storage?: Store): boolean {
  try {
    if (!storage || progress.unsupported) return false;
    // A newer tab may have written after this instance loaded. Preserve that save on pagehide too.
    const raw = storage.getItem(PROGRESS_KEY);
    if (raw) {
      let current: unknown;
      try { current = JSON.parse(raw); } catch { /* A corrupt V1 record can be repaired. */ }
      if (current && typeof current === 'object') {
        const v = current as Record<string, unknown>;
        if ((typeof v.schema === 'number' && v.schema > 1) || (typeof v.balance === 'number' && v.balance > BALANCE.version)) return false;
      }
    }
    storage.setItem(PROGRESS_KEY, JSON.stringify(progress)); return true;
  } catch { return false; }
}
export function partResult(progress: Progress, station: number, section: number): PartResult {
  return progress.parts[sectionKey(station, section)] ?? emptyPart();
}
export function canPlayPart(progress: Progress, station: number, section: number): boolean {
  return Number.isInteger(station) && Number.isInteger(section) && station >= 0 && section >= 0 && section < 3 && station <= progress.unlocked
    && (station < progress.unlocked || section <= progress.current.section || progress.completed);
}
export function claimStar(progress: Progress, game: Game, id: string): boolean {
  if (!game.campaign || game.campaign.practice || progress.claimed.includes(id)) return false;
  progress.claimed.push(id); return true;
}
export function recordFailure(progress: Progress, game: Game) {
  const c = game.campaign; if (!c || c.practice) return;
  const key = sectionKey(c.station, c.section), result = progress.parts[key] ?? emptyPart(); result.failures++; progress.parts[key] = result;
}
export function finishPart(progress: Progress, game: Game): boolean {
  const c = game.campaign;
  if (!c || game.mode !== 'complete' || c.practice) return false;
  const key = sectionKey(c.station, c.section), result = progress.parts[key] ?? emptyPart();
  const stars = c.stars.filter(s => s.collected).length;
  result.done = true;
  if (!c.assistedEver) { result.clean = true; result.bestStars = Math.max(result.bestStars, stars); result.perfect ||= stars === c.stars.length; }
  progress.parts[key] = result; progress.tutorial ||= c.station === 0 && c.section === 2; frontier(progress); return true;
}
export function stationMedal(progress: Progress, station: number): 'perfect' | 'skill' | 'completed' | null {
  const parts = [0, 1, 2].map(n => partResult(progress, station, n));
  if (!parts.every(p => p.done)) return null;
  if (parts.every(p => p.perfect)) return 'perfect';
  return parts.every(p => p.clean) ? 'skill' : 'completed';
}

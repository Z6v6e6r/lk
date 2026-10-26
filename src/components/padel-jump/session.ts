import { BALANCE } from './campaign.ts';
export const JOURNAL_KEY = 'padlhub.jump.journal.v1';
export type JournalEvent = { event: string; game: string; balance: number; visit: string; station: number; section: number;
  attempt: number; input: 'touch' | 'keyboard' | 'tilt'; assist: boolean; practice: boolean; visibleSeconds: number; controlSeconds: number; reason?: string };
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function readJournal(storage?: Pick<Storage, 'getItem'>): JournalEvent[] {
  try { const v: unknown = JSON.parse(storage?.getItem(JOURNAL_KEY) ?? '[]'); return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && typeof x.event === 'string').slice(-BALANCE.journalLimit) : []; } catch { return []; }
}
/** Local diagnostics only. Clock includes visible automatic screens after first Play, excludes explicit pause/background. */
export function createVisit(id: string) {
  let started = false, firstLanding = false, firstStar = false, moving = false;
  let visibleSeconds = 0, controlSeconds = 0;
  return {
    start() { const first = !started; started = true; return first; },
    advance(seconds: number, visible: boolean, explicitPause: boolean, controlling: boolean) {
      if (!started || !visible || explicitPause || !Number.isFinite(seconds) || seconds <= 0) return;
      visibleSeconds += seconds; if (controlling) controlSeconds += seconds;
    },
    first(kind: 'landing' | 'star' | 'moving') {
      if (kind === 'landing') { if (firstLanding) return false; firstLanding = true; }
      if (kind === 'star') { if (firstStar) return false; firstStar = true; }
      if (kind === 'moving') { if (moving) return false; moving = true; }
      return true;
    },
    times: () => ({ visibleSeconds, controlSeconds }),
    log(event: string, context: Pick<JournalEvent, 'station' | 'section' | 'attempt' | 'input' | 'assist' | 'practice'>,
      enabled: boolean, storage?: Store, reason?: string) {
      const record: JournalEvent = { event, game: BALANCE.gameVersion, balance: BALANCE.version, visit: id, ...context,
        visibleSeconds: +visibleSeconds.toFixed(3), controlSeconds: +controlSeconds.toFixed(3), ...(reason ? { reason } : {}) };
      if (enabled) try { const rows = readJournal(storage); rows.push(record); storage?.setItem(JOURNAL_KEY, JSON.stringify(rows.slice(-BALANCE.journalLimit))); } catch { /* Play remains available with storage denied. */ }
      return record;
    },
  };
}

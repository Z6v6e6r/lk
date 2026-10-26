import { createCampaignGame } from './engine.ts';
import type { Game } from './engine';
import type { LivePlayer } from './live-contract';

type Action = 'retry' | 'advance' | 'resume' | 'finish';
type Options = {
  game: () => Game; replace: (game: Game) => void;
  connection: () => { command: (action: Action | 'pause') => Promise<unknown> } | null;
  foreground: () => boolean; prepareResume: () => Promise<void>;
  stopped: () => boolean; canPause: () => boolean;
  changed: () => void; pending: (value: boolean) => void;
};

/** A transition and any deferred lifecycle pause finish before prediction resumes. */
export function createRaceControl(options: Options) {
  let busy = false, wanted = false, disposed = false, previous: Game['mode'] = 'running';
  let operation = Promise.resolve();
  const stopped = () => disposed || options.stopped();
  const notify = () => { if (!disposed) options.changed(); };
  const pauseNow = async () => {
    const connection = options.connection(), game = options.game();
    if (!connection || stopped() || !options.canPause() || game.mode === 'paused') return;
    previous = game.mode; game.mode = 'paused'; notify();
    await connection.command('pause'); wanted = false;
  };
  const perform = (work: () => Promise<void>) => {
    busy = true; options.pending(true);
    operation = (async () => { try { await work(); } finally { busy = false; if (!disposed) { options.pending(false); notify(); } } })();
    return operation;
  };
  return {
    canStep: () => !stopped() && !busy && !wanted && options.foreground(),
    reset() { disposed = false; wanted = false; previous = 'running'; },
    pause() {
      if (stopped() || !options.connection() || !options.canPause()) return Promise.resolve();
      wanted = true;
      if (busy) return operation;
      if (options.game().mode === 'paused') return Promise.resolve();
      return perform(pauseNow);
    },
    command(action: Action) {
      const connection = options.connection(), game = options.game();
      if (!connection || stopped() || busy) return Promise.resolve();
      if (action === 'resume' ? game.mode !== 'paused' : action === 'retry' ? game.mode !== 'over' : game.mode !== 'complete') return Promise.resolve();
      return perform(async () => {
        if (action === 'resume') {
          wanted = false; await options.prepareResume();
          if (stopped() || wanted || !options.foreground()) return;
        }
        await connection.command(action);
        if (stopped()) return;
        if (action === 'advance' || action === 'retry') {
          const c = options.game().campaign!;
          const next = createCampaignGame(action === 'advance' && c.section === 2 ? c.station + 1 : c.station, action === 'advance' ? (c.section + 1) % 3 : c.section);
          next.mode = 'running'; options.replace(next);
        } else if (action === 'resume') options.game().mode = previous;
        if (action !== 'finish' && (wanted || !options.foreground())) await pauseNow();
      });
    },
    acknowledge(player: LivePlayer) {
      const game = options.game(), authoritative = player.game;
      if (game.campaign?.station !== authoritative.campaign?.station || game.campaign?.section !== authoritative.campaign?.section) return;
      if (player.state === 'paused') { previous = authoritative.mode; game.mode = 'paused'; }
      else if (authoritative.mode === 'complete' || authoritative.mode === 'over') {
        if (game.mode === 'paused') previous = authoritative.mode;
        else game.mode = authoritative.mode;
        Object.assign(game.ball, authoritative.ball); game.score = authoritative.score; game.peak = authoritative.peak; game.camera = authoritative.camera;
      }
      notify();
    },
    dispose() { disposed = true; },
  };
}

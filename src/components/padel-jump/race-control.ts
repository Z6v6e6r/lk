import { restoreRaceSnapshot } from './race-prediction.ts';
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
  let confirmed: LivePlayer | undefined;
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
    checkpointConfirmed: () => confirmed?.state === 'checkpoint' && confirmed.game.mode === 'complete'
      && confirmed.game.campaign?.station === options.game().campaign?.station && confirmed.game.campaign?.section === options.game().campaign?.section,
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
      if (action === 'resume' ? game.mode !== 'paused' : action === 'retry' ? game.mode !== 'over' : action === 'finish' ? game.mode !== 'complete' && confirmed?.state !== 'eliminated' : game.mode !== 'complete') return Promise.resolve();
      return perform(async () => {
        if (action === 'resume') {
          wanted = false; await options.prepareResume();
          if (stopped() || wanted || !options.foreground()) return;
        }
        const accepted = await connection.command(action);
        if (stopped()) return;
        if (accepted === false) return;
        if (action === 'resume') options.game().mode = previous;
        if (action !== 'finish' && (wanted || !options.foreground())) await pauseNow();
      });
    },
    acknowledge(player: LivePlayer, prediction?: Game) {
      const local = options.game(), authoritative = player.game;
      const before = local.campaign!.station * 3 + local.campaign!.section, after = authoritative.campaign!.station * 3 + authoritative.campaign!.section;
      if (after < before || after > before + 1) return;
      const game = prediction ?? restoreRaceSnapshot(authoritative);
      confirmed = player;
      if (player.state === 'paused' || local.mode === 'paused') { previous = game.mode; game.mode = 'paused'; }
      options.replace(game);
      notify();
    },
    dispose() { disposed = true; },
  };
}

import { drainEvents, stepGame } from './engine.ts';
import type { Game } from './engine';
import type { InputBlock, LivePlayer } from './live-contract';

/** Own-run ACKs contain the complete simulation, unlike the public live wall. */
export function restoreRaceSnapshot(authoritative: Game): Game {
  const game = structuredClone(authoritative);
  game.events = [];
  return game;
}

/** Rebase only unsent prediction. Never invent an accepted input or score. */
export function predictRaceAcknowledgement(player: LivePlayer, pending: readonly InputBlock[]) {
  const game = restoreRaceSnapshot(player.game), inputs: InputBlock[] = [];
  if (player.state !== 'playing' || game.mode !== 'running') return { game, inputs };
  for (const [direction, count] of pending) {
    let accepted = 0;
    while (accepted < count && game.mode === 'running') { stepGame(game, direction / 100); drainEvents(game); accepted++; }
    if (accepted) inputs.push([direction, accepted]);
    if (game.mode !== 'running') break;
  }
  return { game, inputs };
}

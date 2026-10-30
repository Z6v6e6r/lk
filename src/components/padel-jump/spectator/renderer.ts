import type { Game } from '../engine';
import { drawGame } from '../render';
import { loadYasenevoArt } from '../yasenevo-assets';
import { loadStationPainting } from '../station-art';
import { loadRacketArt } from '../racket-art';
import { loadStationActors } from '../station-actors';

export type SpectatorFrame = { game?: Game; pose?: { x: number; y: number } | null; state: string };
export type RendererSize = { width: number; height: number; dpr: number };

/** Adapter around the original art renderer, never a remote Game simulation. */
export function createReadonlyRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('CANVAS_UNAVAILABLE');
  const context = ctx;
  let active = true, station = -1, generation = 0;
  let size: RendererSize = { width: 0, height: 0, dpr: 1 }, last: SpectatorFrame | null = null;
  let art: Awaited<ReturnType<typeof loadYasenevoArt>> | null = null;
  let scene: Awaited<ReturnType<typeof loadStationPainting>> = null;
  let rackets: Awaited<ReturnType<typeof loadRacketArt>> = null;
  let actors: Awaited<ReturnType<typeof loadStationActors>> = null;
  function draw(frame: SpectatorFrame) {
    if (!active || !frame.game || !size.width || !size.height) return;
    last = frame;
    const nextStation = frame.game.campaign!.station;
    if (station !== nextStation) {
      station = nextStation; const ownGeneration = ++generation;
      art = null; scene = null; actors = null;
      void Promise.all([station === 0 ? loadYasenevoArt() : null, loadStationPainting(station), loadRacketArt(), loadStationActors(station)]).then(([yas, painting, bats, people]) => {
        if (!active || ownGeneration !== generation) return;
        art = yas; scene = painting; rackets = bats; actors = people;
        if (last) draw(last);
      });
    }
    drawGame(context, frame.game, size.width, size.height, size.dpr, true, art, scene, rackets, undefined, actors);
  }
  return {
    draw,
    resize(next: RendererSize) { size = next; },
    dispose() { active = false; generation++; last = null; art = null; scene = null; rackets = null; actors = null; },
  };
}

import { HEIGHT, WIDTH } from './engine';
import type { Game } from './engine';
import { STATIONS } from './campaign';
import type { StationPainting } from './station-art';
import { panoramaRect } from './yasenevo-layout';

export function stationScenery(ctx: CanvasRenderingContext2D, game: Game, art: StationPainting, overscanY: number) {
  const station = STATIONS[art.station];
  ctx.fillStyle = station.sky[0]; ctx.fillRect(-WIDTH * 5, -HEIGHT * 5, WIDTH * 11, HEIGHT * 11);
  const scene = panoramaRect(game.camera, game.campaign!.goalY, WIDTH, HEIGHT, overscanY, art.image.naturalHeight / art.image.naturalWidth);
  ctx.drawImage(art.image, scene.x, scene.y, scene.w, scene.h);
  // Original brand artwork, independent of the painting and all collision geometry.
  ctx.save(); ctx.globalAlpha = 0.88;
  ctx.drawImage(art.flag, 8, 95, 52, 136.5);
  ctx.drawImage(art.flag, WIDTH - 60, 262, 52, 136.5);
  if (station.construction || art.station === 3) ctx.drawImage(art.poster, WIDTH - 106, HEIGHT - 204, 88, 88 * 220 / 180);
  ctx.restore();
}

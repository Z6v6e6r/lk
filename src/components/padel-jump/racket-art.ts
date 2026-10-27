import black from '../../assets/yasenevo-v2/racket_black_platform.svg';
import red from '../../assets/yasenevo-v2/racket_red_platform.svg';
import { surfaceRect } from './yasenevo-layout';

export type RacketArt = { images: { racket_black_platform: HTMLImageElement; racket_red_platform: HTMLImageElement } };
export const RACKET_SPRITE = { w: 240, h: 88, surface: { x: 20, y: 11, width: 114 } };
let cached: Promise<RacketArt | null> | undefined;

/** Shared by all campaign stations, without loading Yasenevo's environment. */
export function loadRacketArt(): Promise<RacketArt | null> {
  return cached ??= Promise.all([black, red].map(url => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (ok && image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image);
      else reject(new Error('Racket artwork unavailable'));
    };
    const timer = setTimeout(() => finish(false), 8000);
    image.onload = () => finish(true); image.onerror = () => finish(false); image.src = url;
  }))).then(([racket_black_platform, racket_red_platform]) => ({ images: { racket_black_platform, racket_red_platform } }))
    .catch(() => { cached = undefined; return null; });
}

export function drawRacket(ctx: CanvasRenderingContext2D, id: number, width: number, art: RacketArt) {
  const rect = surfaceRect(width, RACKET_SPRITE);
  ctx.drawImage(art.images[id % 2 ? 'racket_red_platform' : 'racket_black_platform'], rect.x, rect.y, rect.w, rect.h);
}

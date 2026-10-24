import seligerskaya from '../../assets/station-backgrounds/seligerskaya.webp';
import skolkovo from '../../assets/station-backgrounds/skolkovo.webp';
import terekhovo from '../../assets/station-backgrounds/terekhovo.webp';
import nagatinskaya from '../../assets/station-backgrounds/nagatinskaya.webp';
import premium from '../../assets/station-backgrounds/nagatinskaya-premium.webp';
import piter from '../../assets/station-backgrounds/piter.webp';
import sochi from '../../assets/station-backgrounds/sochi.webp';
import kotelniki from '../../assets/station-backgrounds/kotelniki.webp';
import zavidovo from '../../assets/station-backgrounds/zavidovo.webp';
import kolomenskoe from '../../assets/station-backgrounds/kolomenskoe.webp';
import flagUrl from '../../assets/yasenevo-v2/flag_padlhub.svg';
import posterUrl from '../../assets/yasenevo-v2/poster_build_ourselves.svg';

/** Index matches campaign station IDs. Yasenevo retains its existing artwork loader. */
export const STATION_PAINTINGS = [null, seligerskaya, skolkovo, terekhovo, nagatinskaya, premium, piter, sochi, kotelniki, zavidovo, kolomenskoe] as const;
export type StationPainting = { station: number; image: HTMLImageElement; flag: HTMLImageElement; poster: HTMLImageElement };

function readImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (ok && image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image);
      else reject(new Error('Station painting unavailable'));
    };
    const timer = setTimeout(() => finish(false), 8000);
    image.onload = () => finish(true); image.onerror = () => finish(false); image.src = url;
  });
}
let branding: Promise<[HTMLImageElement, HTMLImageElement]> | undefined;
const cache = new Map<number, Promise<StationPainting | null>>();

/** Lazy station loads; keep at most three decoded scenes reachable through the cache. */
export function loadStationPainting(station: number): Promise<StationPainting | null> {
  const url = STATION_PAINTINGS[station];
  if (!url) return Promise.resolve(null);
  const hit = cache.get(station);
  if (hit) { cache.delete(station); cache.set(station, hit); return hit; }
  branding ??= Promise.all([readImage(flagUrl), readImage(posterUrl)]).catch(error => { branding = undefined; throw error; });
  const pending = Promise.all([readImage(url), branding]).then(([image, [flag, poster]]) => ({ station, image, flag, poster }))
    .catch(() => { if (cache.get(station) === pending) cache.delete(station); return null; });
  cache.set(station, pending);
  while (cache.size > 3) cache.delete(cache.keys().next().value!);
  return pending;
}

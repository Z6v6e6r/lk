import adminUrl from '../../assets/station-actors/seligerskaya-admin.webp';

export type StationActors = { station: 1; admin: HTMLImageElement };
let pending: Promise<StationActors | null> | undefined;

/** Optional actor art loads independently: a missing sprite cannot block play or scenery. */
export function loadStationActors(station: number): Promise<StationActors | null> {
  if (station !== 1) return Promise.resolve(null);
  pending ??= new Promise<StationActors | null>(resolve => {
    const image = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (ok && image.naturalWidth === 1254 && image.naturalHeight === 1254) resolve({ station: 1, admin: image });
      else { pending = undefined; resolve(null); }
    };
    const timer = setTimeout(() => finish(false), 8000);
    image.onload = () => finish(true); image.onerror = () => finish(false); image.src = adminUrl;
  });
  return pending;
}

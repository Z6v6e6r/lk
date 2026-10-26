/** Authored short beats: stairs, held lanes, zigzags and reversals, never a single sine path. */
const MOTIFS = [
  [1, 1, 0, -1, 0, -1], [0, -1, -1, 0, 1, 1],
  [-1, 1, 1, -1, -1, 1], [1, 0, 1, 0, -2, 0],
  [0, 0, -1, -1, 1, 1], [-1, -1, 1, 1, 0, 0],
  [1, -1, 0, 1, -1, 0], [0, 1, 0, -1, 1, -1],
] as const;

export function stationRoute(station: number, section: number, count: number, gap: number) {
  let center = 210, y = 50;
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1, beat = Math.max(0, id - 4);
    const motif = MOTIFS[(Math.floor(beat / 6) + station * 2 + section * 3) % MOTIFS.length];
    const step = station === 0 && section === 0 && id < 10 ? 12 : 26 + section * 3;
    center = id <= 3 ? [210, 198, 218][index] : Math.max(96, Math.min(310, center + motif[beat % 6] * step));
    y += gap + (id <= 3 ? 0 : [0, -8, 6, 0, -4, 8][(beat + station + section) % 6]);
    return { id, center, y };
  });
}

export function supportWidth(kind: string, base: number, id: number, station: number, section: number) {
  if (kind === 'racket') return 40;
  if (id <= 3) return [192, 152, 176][id - 1];
  const widths = kind === 'net' ? [104, 144, 184] : kind === 'crumble' ? [88, 128, 164] : [108, 164, 132, 198, 148];
  const width = widths[(id + station * 2 + section) % widths.length];
  return kind === 'court' && id % 6 === 0 ? Math.max(164, width) : Math.min(base + 40, width);
}

/** Expanded swept segment test, used by interior glass so fast contacts cannot tunnel. */
export function crossesRect(x0: number, y0: number, x1: number, y1: number, x: number, y: number, w: number, h: number, radius: number) {
  let near = 0, far = 1;
  for (const [start, delta, lo, hi] of [[x0, x1 - x0, x - radius, x + w + radius], [y0, y1 - y0, y - radius, y + h + radius]]) {
    if (Math.abs(delta) < 1e-9) { if (start < lo || start > hi) return false; continue; }
    const a = (lo - start) / delta, b = (hi - start) / delta;
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return true;
}

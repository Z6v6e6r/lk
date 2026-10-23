/** Map artwork's supporting head/surface onto the existing physics span; the handle adds no collision. */
export function surfaceRect(width: number, sprite: { w: number; h: number; surface: { x: number; y: number; width: number } }) {
  const scale = width / sprite.surface.width;
  return { x: -sprite.surface.x * scale, y: -sprite.surface.y * scale, w: sprite.w * scale, h: sprite.h * scale };
}

/** A single continuous 1:3 painting: blue court at the bottom, upper scaffolds at the finish.
 * Clamp the finite campaign ascent rather than wrapping the scene or stretching its sky.
 */
export function panoramaRect(camera: number, goalY: number, width: number, height: number, overscanY = 0, aspect = 3) {
  const visibleHeight = height + overscanY * 2;
  const h = Math.max(width * aspect, visibleHeight), w = h / aspect;
  const progress = Math.max(0, Math.min(1, camera / Math.max(1, goalY - height * 0.43)));
  return { x: (width - w) / 2, y: height + overscanY - h + progress * (h - visibleHeight), w, h };
}

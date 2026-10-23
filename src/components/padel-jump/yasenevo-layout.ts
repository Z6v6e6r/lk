/** Map artwork's supporting head/surface onto the existing physics span; the handle adds no collision. */
export function surfaceRect(width: number, sprite: { w: number; h: number; surface: { x: number; y: number; width: number } }) {
  const scale = width / sprite.surface.width;
  return { x: -sprite.surface.x * scale, y: -sprite.surface.y * scale, w: sprite.w * scale, h: sprite.h * scale };
}

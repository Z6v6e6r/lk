/** Balance is in the existing 420×640 world, seconds and world units per second. */
export const BALANCE = {
  version: 1, gameVersion: 'campaign-1', sections: 3, intermission: 1.6,
  collapseSeconds: 0.72, glassSpeed: 860, glassInward: 180, glassRecovery: 0.28, maxSpeedX: 420,
  dropWarning: 1, dropSpeed: 360, dropKnockdown: 240, hitProtection: 0.85,
  adminWarning: 1.3, adminCatch: 0.8, adminRetreat: 0.6,
  assistanceAfterFailures: 2, journalLimit: 200,
} as const;
export type Theme = 'yard' | 'sunset' | 'city' | 'works' | 'glass' | 'spa' | 'piter' | 'sochi' | 'shell';
export type Station = { name: string; skill: string; hint: string; theme: Theme; sky: [string, string]; accent: string; construction?: boolean };
export const STATIONS: readonly Station[] = [
  { name: 'Ясенево', skill: 'Первый взлёт', hint: 'Веди мяч влево и вправо. Ракетки выдерживают один отскок.', theme: 'yard', sky: ['#57bcfa', '#cceff3'], accent: '#7949e8' },
  { name: 'Селигерская', skill: 'Поймай движение', hint: 'Смотри, куда едет ракетка. Первая движется медленно.', theme: 'sunset', sky: ['#f39a92', '#f8d1a1'], accent: '#b13b91' },
  { name: 'Сколково', skill: 'Найди обход', hint: 'Металл сверху опасен. Выбирай свободную сторону.', theme: 'city', sky: ['#79bceb', '#c9e8ef'], accent: '#397eca' },
  { name: 'Терехово', skill: 'Опора на один раз', hint: 'Треснувшие опоры исчезают после отскока. Оранжевые остаются.', theme: 'works', sky: ['#dfbd99', '#f7deaf'], accent: '#cd7940' },
  { name: 'Нагатинская', skill: 'Рикошет от стекла', hint: 'Коснись стекла сбоку: оно даст буст к широкой опоре.', theme: 'glass', sky: ['#5abef9', '#cee9fa'], accent: '#247eb6' },
  { name: 'Нагатинская Премиум', skill: 'Между каплями', hint: 'Капля сначала предупреждает, потом падает прямо вниз.', theme: 'spa', sky: ['#416e67', '#c4d2b6'], accent: '#aa823e' },
  { name: 'Питер', skill: 'Поймай ритм', hint: 'Опоры делают паузу. Выбирай момент следующего прыжка.', theme: 'piter', sky: ['#344568', '#d8a9c0'], accent: '#b37ba8' },
  { name: 'Сочи', skill: 'Выбери свой темп', hint: 'Есть спокойный путь и необязательные ускорения через стекло.', theme: 'sochi', sky: ['#b57cc9', '#ffd1a2'], accent: '#dd69aa' },
  { name: 'Котельники', skill: 'Точный проход', hint: 'Проходы уже. Сначала выбери опору, затем направление.', theme: 'shell', sky: ['#9ca5aa', '#d5d9da'], accent: '#e0ad42', construction: true },
  { name: 'Завидово', skill: 'На два шага вперёд', hint: 'Смотри на две следующие опоры. Использованная ракетка не спасёт.', theme: 'shell', sky: ['#adb9c4', '#e0e4e4'], accent: '#c7a748', construction: true },
  { name: 'Коломенское', skill: 'Твой маршрут', hint: 'Точность, планирование, ускорение. Последняя станция!', theme: 'shell', sky: ['#a9b2ba', '#d9dedf'], accent: '#9d92c1', construction: true },
];
export type SectionBalance = {
  count: number; gap: number; width: number; sway: number; phase: number;
  movingEvery: number; amplitude: number; omega: number; rhythm: boolean;
  metalEvery: number; crumbleEvery: number; glassEvery: number; dropsEvery: number; adminEvery: number; springEvery: number;
};
export function sectionBalance(station: number, section: number): SectionBalance {
  const c: SectionBalance = { count: 78 + section * 6, gap: 82, width: 158, sway: 112, phase: 0.55,
    movingEvery: 0, amplitude: 18, omega: 0.9, rhythm: false, metalEvery: 0, crumbleEvery: 0,
    glassEvery: 0, dropsEvery: 0, adminEvery: 0, springEvery: station >= 2 ? 13 : 0 };
  if (station === 0) return { ...c, count: [32, 34, 36][section], gap: section === 2 ? 90 : 78,
    width: 160, sway: section === 0 ? 40 : 115 };
  if (station === 1) return { ...c, gap: section === 0 ? 78 : 90, width: 160, sway: 40,
    movingEvery: 8, amplitude: section === 2 ? 28 : 16, adminEvery: section === 2 ? 28 : 0, springEvery: section === 2 ? 16 : 0 };
  if (station === 2) { c.metalEvery = section === 0 ? 16 : 9; c.movingEvery = section === 2 ? 7 : 0; }
  if (station === 3) { c.crumbleEvery = section === 0 ? 5 : 2; c.width = section === 2 ? 124 : 158; }
  if (station === 4) { c.glassEvery = 12; c.width = 174; c.springEvery = 0; }
  if (station === 5) { c.glassEvery = section === 2 ? 17 : 0; c.dropsEvery = section === 0 ? 20 : 12; c.metalEvery = section === 2 ? 18 : 0; }
  if (station === 6) { c.movingEvery = 3; c.rhythm = true; c.amplitude = 20 + section * 5; c.metalEvery = section === 2 ? 15 : 0; }
  if (station === 7) { c.glassEvery = 14; c.movingEvery = section === 2 ? 6 : 0; }
  if (station === 8) { c.width = 138 - section * 12; c.sway = 78; c.metalEvery = 11 - section; }
  if (station === 9) { c.movingEvery = 4; c.crumbleEvery = 3; c.amplitude = 20; }
  if (station === 10) {
    c.width = 130; c.metalEvery = section === 0 ? 10 : 0;
    c.movingEvery = section === 1 ? 4 : 0; c.crumbleEvery = section === 1 ? 3 : 0;
    c.glassEvery = section === 2 ? 16 : 0; c.dropsEvery = section === 2 ? 19 : 0;
  }
  return c;
}
export const sectionKey = (station: number, section: number) => `${station}:${section}`;
export function nextSection(station: number, section: number): { station: number; section: number } | null {
  return section < 2 ? { station, section: section + 1 } : station < STATIONS.length - 1 ? { station: station + 1, section: 0 } : null;
}

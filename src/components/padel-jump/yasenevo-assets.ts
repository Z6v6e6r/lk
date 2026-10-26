import platform_blue from '../../assets/yasenevo-v2/platform_blue.svg';
import platform_blue_wide from '../../assets/yasenevo-v2/platform_blue_wide.svg';
import racket_black_platform from '../../assets/yasenevo-v2/racket_black_platform.svg';
import racket_red_platform from '../../assets/yasenevo-v2/racket_red_platform.svg';
import ball from '../../assets/yasenevo-v2/ball.svg';
import ball_squash from '../../assets/yasenevo-v2/ball_squash.svg';
import ball_trail from '../../assets/yasenevo-v2/ball_trail.svg';
import star_gold from '../../assets/yasenevo-v2/star_gold.svg';
import spring_idle from '../../assets/yasenevo-v2/spring_idle.svg';
import spring_pressed from '../../assets/yasenevo-v2/spring_pressed.svg';
import spring_rebound from '../../assets/yasenevo-v2/spring_rebound.svg';
import flag_padlhub from '../../assets/yasenevo-v2/flag_padlhub.svg';
import banner_padlhub from '../../assets/yasenevo-v2/banner_padlhub.svg';
import poster_build_ourselves from '../../assets/yasenevo-v2/poster_build_ourselves.svg';
import worker_navy_walk_00 from '../../assets/yasenevo-v2/worker_navy_walk_00.svg';
import worker_navy_walk_01 from '../../assets/yasenevo-v2/worker_navy_walk_01.svg';
import worker_navy_walk_02 from '../../assets/yasenevo-v2/worker_navy_walk_02.svg';
import worker_navy_walk_03 from '../../assets/yasenevo-v2/worker_navy_walk_03.svg';
import worker_green_panel from '../../assets/yasenevo-v2/worker_green_panel.svg';
import worker_cream_inspector from '../../assets/yasenevo-v2/worker_cream_inspector.svg';
import decor_stepladder from '../../assets/yasenevo-v2/decor_stepladder.svg';
import decor_toolcase from '../../assets/yasenevo-v2/decor_toolcase.svg';
import dome_loop from '../../assets/yasenevo-v2/dome_loop.svg';
import station_start from '../../assets/yasenevo-v2/station_start.svg';
import cage_left from '../../assets/yasenevo-v2/cage_left.svg';
import padel_sleeve from '../../assets/yasenevo-v2/padel_sleeve.svg';
import cage_right from '../../assets/yasenevo-v2/cage_right.svg';

/** Original supplied SVGs. Only image data is imported; the supplied demo/loader is not executed. */
export const YASENEVO_SPRITES = {
  platform_blue: { url: platform_blue, w: 192, h: 64, surface: {"x": 14, "y": 12, "width": 164} },
  platform_blue_wide: { url: platform_blue_wide, w: 240, h: 64, surface: {"x": 14, "y": 12, "width": 212} },
  racket_black_platform: { url: racket_black_platform, w: 240, h: 88, surface: {"x": 20, "y": 11, "width": 114} },
  racket_red_platform: { url: racket_red_platform, w: 240, h: 88, surface: {"x": 20, "y": 11, "width": 114} },
  ball: { url: ball, w: 128, h: 128 },
  ball_squash: { url: ball_squash, w: 128, h: 128 },
  ball_trail: { url: ball_trail, w: 80, h: 192 },
  star_gold: { url: star_gold, w: 96, h: 96 },
  spring_idle: { url: spring_idle, w: 208, h: 96, surface: {"x": 26, "y": 25, "width": 156} },
  spring_pressed: { url: spring_pressed, w: 208, h: 96, surface: {"x": 26, "y": 25, "width": 156} },
  spring_rebound: { url: spring_rebound, w: 208, h: 96, surface: {"x": 26, "y": 25, "width": 156} },
  flag_padlhub: { url: flag_padlhub, w: 96, h: 252 },
  banner_padlhub: { url: banner_padlhub, w: 320, h: 96 },
  poster_build_ourselves: { url: poster_build_ourselves, w: 180, h: 220 },
  worker_navy_walk_00: { url: worker_navy_walk_00, w: 88, h: 160 },
  worker_navy_walk_01: { url: worker_navy_walk_01, w: 88, h: 160 },
  worker_navy_walk_02: { url: worker_navy_walk_02, w: 88, h: 160 },
  worker_navy_walk_03: { url: worker_navy_walk_03, w: 88, h: 160 },
  worker_green_panel: { url: worker_green_panel, w: 88, h: 160 },
  worker_cream_inspector: { url: worker_cream_inspector, w: 88, h: 160 },
  decor_stepladder: { url: decor_stepladder, w: 80, h: 160 },
  decor_toolcase: { url: decor_toolcase, w: 80, h: 48 },
  dome_loop: { url: dome_loop, w: 720, h: 1440 },
  station_start: { url: station_start, w: 720, h: 1440 },
  cage_left: { url: cage_left, w: 112, h: 1440 },
  cage_right: { url: cage_right, w: 112, h: 1440 },
  padel_sleeve: { url: padel_sleeve, w: 2834.6, h: 283.5 },
} as const;
export type YasenevoSprite = keyof typeof YASENEVO_SPRITES;
export type YasenevoArt = { images: Record<YasenevoSprite, HTMLImageElement> };
let cached: Promise<YasenevoArt | null> | undefined;
export function loadYasenevoArt(): Promise<YasenevoArt | null> {
  return cached ??= Promise.all((Object.keys(YASENEVO_SPRITES) as YasenevoSprite[]).map(id => new Promise<[YasenevoSprite, HTMLImageElement]>((resolve, reject) => {
    const image = new Image();
    const finish = (ok: boolean) => {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (ok && image.naturalWidth > 0) resolve([id, image]); else reject(new Error('Yasenevo artwork unavailable'));
    };
    const timer = setTimeout(() => finish(false), 8000);
    image.onload = () => finish(true); image.onerror = () => finish(false); image.src = YASENEVO_SPRITES[id].url;
  }))).then(images => ({ images: Object.fromEntries(images) as YasenevoArt['images'] })).catch(() => null);
}

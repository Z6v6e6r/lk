/**
 * Фото на шапку карточки.
 *
 * Набор — те же клубные фото, что LK2 раскладывает по карточкам рекомендаций
 * (`lk2.padlhub.su`), перезалитые на наш CDN со стабильными именами: у LK2 имена
 * содержат хэш сборки и меняются при каждом деплое.
 */

export const ATLANTY_CARD_IMAGE_BASE = "https://padlhub.su/lk/atlanty-cards/";

/** Полный пул (30 фото): корты Сколково и Нагатинской Премиум, баннеры и промо. */
export const ATLANTY_CARD_IMAGES: readonly string[] = [
  "skolkovo-game-1.webp",
  "skolkovo-game-2.webp",
  "skolkovo-game-3.webp",
  "skolkovo-game-4.webp",
  "skolkovo-coach-game-1.webp",
  "skolkovo-coach-game-2.webp",
  "skolkovo-training-1.webp",
  "skolkovo-training-2.webp",
  "skolkovo-training-3.webp",
  "skolkovo-tournament-1.webp",
  "premium-game-1.webp",
  "premium-game-2.webp",
  "premium-game-3.webp",
  "premium-game-4.webp",
  "premium-game-5.webp",
  "premium-game-6.webp",
  "premium-coach-game-1.webp",
  "premium-training-1.webp",
  "premium-training-2.webp",
  "premium-tournament-1.webp",
  "hero-game.webp",
  "hero-tournament.webp",
  "hero-training.webp",
  "card-art-coach-game.webp",
  "card-art-tournament.webp",
  "card-art-training.webp",
  "promo-hero-fallback.png",
  "promo.png",
  "nagatinskaya-default.webp",
  "nagatinskaya-tournament.webp",
];

export type AtlantyImagePick = "shuffle" | "hash";

export const ATLANTY_DEFAULT_IMAGE_PICK: AtlantyImagePick = "shuffle";

function toAbsolute(name: string) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) return raw;
  if (raw.startsWith("/")) return raw;
  return `${ATLANTY_CARD_IMAGE_BASE}${raw.replace(/^\.?\//, "")}`;
}

/** Пул из конфига (можно передать свои URL) или встроенный набор. */
export function resolveAtlantyCardImages(value: unknown): string[] {
  const source = Array.isArray(value) ? value : ATLANTY_CARD_IMAGES;
  const result: string[] = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const url = toAbsolute(item);
    if (url && !result.includes(url)) result.push(url);
  }
  return result;
}

export function normalizeAtlantyImagePick(value: unknown): AtlantyImagePick {
  return String(value ?? "").trim().toLowerCase() === "hash" ? "hash" : ATLANTY_DEFAULT_IMAGE_PICK;
}

/**
 * Перемешивание пула (Fisher–Yates). `random` можно подменить в тестах.
 */
export function shuffleAtlantyImages(
  images: readonly string[],
  random: () => number = Math.random,
): string[] {
  const result = [...images];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [result[index], result[swapWith]] = [result[swapWith], result[index]];
  }
  return result;
}

/** Стабильный индекс по строке (как в LK2: s = s * 31 + код символа). */
export function hashAtlantyImageIndex(seed: string, length: number) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  let hash = 0;
  const value = String(seed ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) >>> 0;
  }
  return hash % length;
}

/**
 * Фото для карточки: `shuffle` — по позиции в перемешанном пуле (стабильно
 * в пределах загрузки страницы), `hash` — по id события, как в LK2.
 */
export function pickAtlantyCardImage(params: {
  images: readonly string[];
  seed: string;
  index: number;
  pick?: AtlantyImagePick;
}): string | null {
  const images = params.images;
  if (images.length === 0) return null;
  if (params.pick === "hash") {
    return images[hashAtlantyImageIndex(params.seed, images.length)] ?? null;
  }
  const index = Math.max(0, Math.trunc(params.index));
  return images[index % images.length] ?? null;
}

export interface SupportPhoto {
  id: string;
  type: "IMAGE";
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
}
export const SUPPORT_PHOTO_TOTAL_BYTES = 2 * 1024 * 1024;

export function normalizeSupportPhotos(value: unknown): SupportPhoto[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((item, index) => {
    if (!item || typeof item !== "object" || item.type !== "IMAGE" || typeof item.url !== "string") return [];
    const url = item.url.trim();
    let safe = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(url) && url.length < 5600000;
    if (!safe) {
      try { const u = new URL(url); safe = u.protocol === "https:" && !u.username && !u.password && !u.hash; } catch { /* invalid URL */ }
    }
    if (!safe) return [];
    return [{ id: typeof item.id === "string" ? item.id : `photo-${index}`, type: "IMAGE" as const, url,
      name: typeof item.name === "string" ? item.name.slice(0, 240) : "Фото",
      mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      size: Number.isFinite(item.size) && item.size >= 0 ? item.size : undefined }];
  });
}

export async function prepareSupportPhoto(file: File): Promise<SupportPhoto> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) {
    throw new Error("Выберите фото JPG, PNG или WebP размером до 20 МБ.");
  }
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Не удалось прочитать фото.")); image.src = source; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error("Фото слишком большое.");
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Не удалось обработать фото.");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    let url = canvas.toDataURL("image/jpeg", 0.85);
    if (url.length > 1400000) url = canvas.toDataURL("image/jpeg", 0.65);
    const size = Math.floor((url.split(",")[1]?.length || 0) * 3 / 4);
    if (size > 1048576) throw new Error("Не удалось уменьшить фото. Выберите файл меньшего размера.");
    return { id: crypto.randomUUID(), type: "IMAGE", url, name: file.name.slice(0, 240), mimeType: "image/jpeg", size };
  } finally { URL.revokeObjectURL(source); }
}

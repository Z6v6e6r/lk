import { getServ2Origin } from "./apiClient";
import { readAuthToken } from "./authTokenStorage";
import { prepareSupportPhoto } from "./supportPhotos";

const MAX_BYTES = 512 * 1024;

export interface StationChatPhotoDraft {
  key: string;
  url: string;
  jpeg: string;
}

export async function prepareStationChatPhoto(file: File): Promise<StationChatPhotoDraft> {
  const { url } = await prepareSupportPhoto(file, MAX_BYTES);
  const jpeg = url.slice(url.indexOf(",") + 1);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jpeg));
  return { key: Array.from(new Uint8Array(hash)).join(","), url, jpeg };
}

export async function loadStationChatPhoto(communityId: string, messageId: string, signal: AbortSignal): Promise<Blob> {
  const token = readAuthToken();
  const origin = getServ2Origin();
  if (!token || !origin) throw new Error("Войдите в личный кабинет, чтобы открыть фото.");

  const url = `${origin.replace(/\/+$/, "")}/lk/communities/${encodeURIComponent(communityId)}/message-photos/${encodeURIComponent(messageId)}`;
  const response = await fetch(url, { signal, redirect: "error", cache: "no-store", credentials: "omit", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "image/jpeg") {
    throw new Error("Не удалось открыть фото.");
  }
  const photo = await response.blob();
  if (photo.size === 0 || photo.size > MAX_BYTES) throw new Error("Не удалось открыть фото.");
  return photo;
}

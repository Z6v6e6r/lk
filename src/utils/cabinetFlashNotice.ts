const CABINET_FLASH_NOTICE_KEY = "padlhub.cabinet.flashNotice.v1";

function hasSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function pushCabinetFlashNotice(message: string | null | undefined): void {
  const normalized = String(message || "").trim();
  if (!normalized || !hasSessionStorage()) return;
  try {
    window.sessionStorage.setItem(CABINET_FLASH_NOTICE_KEY, normalized);
  } catch {
    // ignore storage failures
  }
}

export function consumeCabinetFlashNotice(): string | null {
  if (!hasSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(CABINET_FLASH_NOTICE_KEY);
    window.sessionStorage.removeItem(CABINET_FLASH_NOTICE_KEY);
    const normalized = String(raw || "").trim();
    return normalized || null;
  } catch {
    return null;
  }
}

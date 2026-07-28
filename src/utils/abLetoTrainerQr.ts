const TRAINER_QR_CODE_PATTERN = /^TR-(?:00[1-9]|0[1-4]\d|050)$/;

export function normalizeAbLetoTrainerQrCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return TRAINER_QR_CODE_PATTERN.test(code) ? code : null;
}

export function readAbLetoTrainerQrCode(search = typeof window === "undefined" ? "" : window.location.search): string | null {
  const params = new URLSearchParams(search);
  return normalizeAbLetoTrainerQrCode(params.get("qr"));
}

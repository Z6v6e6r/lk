function decodeBase64UrlSegment(segment: string) {
  const normalized = String(segment || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return null;
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4 || 4)) % 4), "=");

  try {
    if (typeof atob === "function") {
      const decoded = atob(padded);
      return decodeURIComponent(
        decoded
          .split("")
          .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
          .join(""),
      );
    }
  } catch {
    // Fall through to Buffer.
  }

  try {
    const bufferCtor = typeof Reflect !== "undefined" ? Reflect.get(globalThis, "Buffer") : undefined;
    if (bufferCtor && typeof bufferCtor.from === "function") {
      return bufferCtor.from(padded, "base64").toString("utf8");
    }
  } catch {
    // Ignore invalid payloads.
  }

  return null;
}

export function extractJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const normalized = String(token || "").trim();
  if (!normalized) return null;

  const parts = normalized.split(".");
  if (parts.length < 2) return null;

  const payloadText = decodeBase64UrlSegment(parts[1]);
  if (!payloadText) return null;

  try {
    const payload = JSON.parse(payloadText) as unknown;
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function extractJwtStringClaim(
  token: string | null | undefined,
  claimNames: string[],
) {
  const payload = extractJwtPayload(token);
  for (const claimName of claimNames) {
    const value = payload?.[claimName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function getJwtExpiryTimestamp(token: string | null | undefined) {
  const payload = extractJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return exp * 1000;
  }
  return null;
}

export function hasPhoneClaim(token: string | null | undefined) {
  return Boolean(extractJwtStringClaim(token, ["phone_number", "phoneNumber", "phone"]));
}

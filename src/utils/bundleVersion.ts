declare global {
  interface Window {
    __LK_RELEASE_VERSION__?: string;
  }
}

function normalizeBundleVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

export function getBundleVersion(): string | null {
  if (typeof window === "undefined") return null;
  return normalizeBundleVersion(window.__LK_RELEASE_VERSION__);
}

export function appendBundleVersion(src: string): string {
  const version = getBundleVersion();
  if (!version) return src;

  try {
    const baseUrl = typeof window !== "undefined" ? window.location.href : undefined;
    const url = new URL(src, baseUrl);
    url.searchParams.set("v", version);
    return url.toString();
  } catch {
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}v=${encodeURIComponent(version)}`;
  }
}

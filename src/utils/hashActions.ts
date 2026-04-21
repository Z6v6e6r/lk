function normalizeHash(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "#";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

export function resolveHashActionTarget(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw || raw === "#") return null;

  if (raw.startsWith("#")) {
    return normalizeHash(raw);
  }

  if (typeof window === "undefined") return null;

  try {
    const current = new URL(window.location.href);
    const target = new URL(raw, current.href);
    if (!target.hash) return null;
    if (target.origin !== current.origin) return null;
    if (normalizePathname(target.pathname) !== normalizePathname(current.pathname)) return null;
    return normalizeHash(target.hash);
  } catch {
    return null;
  }
}

export function retriggerHashAction(hash: string) {
  if (typeof window === "undefined") return;

  const normalized = normalizeHash(hash);
  if (window.location.hash !== normalized) {
    window.location.hash = normalized;
    return;
  }

  const currentUrl = window.location.href;
  try {
    window.dispatchEvent(new HashChangeEvent("hashchange", {
      oldURL: currentUrl,
      newURL: currentUrl,
    }));
  } catch {
    window.dispatchEvent(new Event("hashchange"));
  }
}

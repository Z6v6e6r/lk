import { getBundleVersion } from "./bundleVersion";

type DevReleaseBadgeOptions = {
  bundleFileNames: string[];
};

const BADGE_ID = "lk-dev-release-badge";
const BADGE_REFRESH_DELAY_MS = 1500;
const BADGE_REVEAL_TAP_TARGET = 5;
const BADGE_REVEAL_RESET_MS = 1400;
const BADGE_REVEAL_CORNER_SIZE_PX = 56;

let badgeRevealTapCount = 0;
let badgeRevealResetTimer: number | null = null;
let isBadgeVisible = false;
let isRevealListenerMounted = false;

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function matchesBundleFileName(src: string, bundleFileNames: string[]): boolean {
  const normalizedSrc = src.trim();
  if (!normalizedSrc) return false;

  try {
    const parsed = new URL(normalizedSrc, typeof window !== "undefined" ? window.location.href : undefined);
    const pathname = parsed.pathname.toLowerCase();
    return bundleFileNames.some((fileName) => pathname.endsWith(`/${fileName.toLowerCase()}`));
  } catch {
    const lowerSrc = normalizedSrc.toLowerCase();
    return bundleFileNames.some((fileName) => lowerSrc.includes(fileName.toLowerCase()));
  }
}

function resolveBundleVersion(bundleFileNames: string[]): string | null {
  const globalVersion = getBundleVersion();
  if (globalVersion) return globalVersion;

  if (typeof document === "undefined") {
    return null;
  }

  const scripts = Array.from(document.scripts).reverse();
  for (const script of scripts) {
    const src = trimString(script.src);
    if (!src || !matchesBundleFileName(src, bundleFileNames)) {
      continue;
    }

    try {
      const parsed = new URL(src, window.location.href);
      const version = trimString(parsed.searchParams.get("v"));
      if (version) return version;
    } catch {
      // ignored
    }
  }

  return null;
}

function renderBadgeText(version: string | null): string {
  return version ? `dev ${version}` : "dev version pending";
}

function resetBadgeRevealProgress() {
  badgeRevealTapCount = 0;
  if (badgeRevealResetTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(badgeRevealResetTimer);
  }
  badgeRevealResetTimer = null;
}

function showBadge() {
  const badge = ensureBadge();
  if (!badge) return;
  badge.style.opacity = "1";
  badge.style.visibility = "visible";
  isBadgeVisible = true;
}

function isBottomLeftCornerTap(clientX: number, clientY: number): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return clientX <= BADGE_REVEAL_CORNER_SIZE_PX
    && clientY >= window.innerHeight - BADGE_REVEAL_CORNER_SIZE_PX;
}

function mountBadgeRevealListener() {
  if (isRevealListenerMounted || typeof window === "undefined") {
    return;
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (isBadgeVisible) {
      return;
    }

    if (!isBottomLeftCornerTap(event.clientX, event.clientY)) {
      resetBadgeRevealProgress();
      return;
    }

    badgeRevealTapCount += 1;

    if (badgeRevealTapCount >= BADGE_REVEAL_TAP_TARGET) {
      resetBadgeRevealProgress();
      showBadge();
      return;
    }

    if (badgeRevealResetTimer !== null) {
      window.clearTimeout(badgeRevealResetTimer);
    }

    badgeRevealResetTimer = window.setTimeout(() => {
      resetBadgeRevealProgress();
    }, BADGE_REVEAL_RESET_MS);
  };

  window.addEventListener("pointerdown", handlePointerDown, { passive: true });
  isRevealListenerMounted = true;
}

function ensureBadge(): HTMLDivElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  const existing = document.getElementById(BADGE_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  badge.setAttribute("aria-hidden", "true");
  badge.style.position = "fixed";
  badge.style.left = "50%";
  badge.style.bottom = "calc(env(safe-area-inset-bottom, 0px) + 8px)";
  badge.style.transform = "translateX(-50%)";
  badge.style.padding = "4px 8px";
  badge.style.borderRadius = "999px";
  badge.style.background = "rgba(245, 245, 247, 0.92)";
  badge.style.color = "#8b8f98";
  badge.style.fontFamily = "\"Source Code Pro\", \"SF Pro Text\", monospace";
  badge.style.fontSize = "10px";
  badge.style.lineHeight = "1";
  badge.style.letterSpacing = "0.04em";
  badge.style.zIndex = "2147483647";
  badge.style.pointerEvents = "none";
  badge.style.opacity = "0";
  badge.style.visibility = "hidden";
  badge.style.transition = "opacity 0.18s ease";
  badge.style.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.08)";
  badge.style.backdropFilter = "blur(6px)";
  badge.style.setProperty("-webkit-backdrop-filter", "blur(6px)");
  document.body.appendChild(badge);
  return badge;
}

export function mountDevReleaseBadge(options: DevReleaseBadgeOptions) {
  if (import.meta.env.MODE !== "dev") {
    return;
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const updateBadge = () => {
    const badge = ensureBadge();
    if (!badge) return;
    const version = resolveBundleVersion(options.bundleFileNames);
    const text = renderBadgeText(version);
    if (badge.textContent !== text) {
      badge.textContent = text;
    }
    badge.title = version ? `Loaded dev release: ${version}` : "Loaded dev release is not resolved yet";
  };

  updateBadge();
  mountBadgeRevealListener();
  window.setTimeout(updateBadge, BADGE_REFRESH_DELAY_MS);
}

import { getBundleVersion } from "./bundleVersion";
import { buildLkAssetFileCandidates, resolveLkAssetBaseUrlFromScript } from "./lkAssetBaseUrls";
import { isLkIdleRequestPaused } from "./lkIdleDataGuard";

type ReleaseGuardOptions = {
  entry: string;
  bundleFileNames: string[];
  releaseFileName?: string;
};

type ReleaseAttemptState = {
  targetVersion: string;
  attemptedAt: number;
};

const DEFAULT_RELEASE_FILE_NAME = import.meta.env.MODE === "dev" ? "release-dev.json" : "release.json";
const RELOAD_QUERY_KEY = "__lkv";
const RELOAD_ATTEMPT_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function getAttemptStorageKey(entry: string): string {
  return `__lk_release_guard_v1__:${entry}`;
}

function readAttemptState(entry: string): ReleaseAttemptState | null {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(getAttemptStorageKey(entry));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReleaseAttemptState> | null;
    const targetVersion = trimString(parsed?.targetVersion);
    const attemptedAt = typeof parsed?.attemptedAt === "number" ? parsed.attemptedAt : 0;
    if (!targetVersion || attemptedAt <= 0) return null;
    return { targetVersion, attemptedAt };
  } catch {
    return null;
  }
}

function writeAttemptState(entry: string, state: ReleaseAttemptState) {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(getAttemptStorageKey(entry), JSON.stringify(state));
  } catch {
    // ignored
  }
}

function clearAttemptState(entry: string) {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(getAttemptStorageKey(entry));
  } catch {
    // ignored
  }
}

function cleanupReloadQuery(currentVersion: string | null) {
  if (
    typeof window === "undefined"
    || typeof history === "undefined"
    || typeof history.replaceState !== "function"
  ) {
    return;
  }

  try {
    const currentUrl = new URL(window.location.href);
    const reloadVersion = trimString(currentUrl.searchParams.get(RELOAD_QUERY_KEY));
    if (!reloadVersion || (currentVersion && reloadVersion !== currentVersion)) {
      return;
    }

    currentUrl.searchParams.delete(RELOAD_QUERY_KEY);
    history.replaceState(history.state, document.title, currentUrl.toString());
  } catch {
    // ignored
  }
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

function resolveBundleScriptUrls(bundleFileNames: string[]): URL[] {
  const result: URL[] = [];
  const seen = new Set<string>();

  const addUrl = (src: string | null | undefined) => {
    const normalizedSrc = trimString(src);
    if (!normalizedSrc || !matchesBundleFileName(normalizedSrc, bundleFileNames)) {
      return;
    }

    try {
      const parsed = new URL(normalizedSrc, window.location.href);
      const key = parsed.toString();
      if (seen.has(key)) return;
      seen.add(key);
      result.push(parsed);
    } catch {
      // ignored
    }
  };

  if (typeof document === "undefined") {
    return result;
  }

  if (document.currentScript instanceof HTMLScriptElement) {
    addUrl(document.currentScript.src);
  }

  Array.from(document.scripts)
    .reverse()
    .forEach((script) => addUrl(script.src));

  return result;
}

function buildManifestCandidates(bundleScriptUrls: URL[], releaseFileName: string): string[] {
  return buildLkAssetFileCandidates(
    releaseFileName,
    bundleScriptUrls.map((url) => resolveLkAssetBaseUrlFromScript(url)),
  );
}

function getCurrentVersion(bundleScriptUrls: URL[]): string | null {
  const windowVersion = getBundleVersion();
  if (windowVersion) return windowVersion;

  for (const bundleScriptUrl of bundleScriptUrls) {
    const version = trimString(bundleScriptUrl.searchParams.get("v"));
    if (version) return version;
  }

  return null;
}

function isRuntimeCacheBusterVersion(version: string): boolean {
  return /^\d{13,}$/.test(version);
}

async function fetchJsonWithTimeout(url: string): Promise<Response> {
  if (typeof AbortController === "undefined") {
    return fetch(url, { cache: "no-store" });
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function resolveLatestVersion(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const response = await fetchJsonWithTimeout(`${candidate}${candidate.includes("?") ? "&" : "?"}ts=${Date.now()}`);
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as { version?: unknown } | null;
      const version = trimString(payload?.version);
      if (version) return version;
    } catch {
      // ignored
    }
  }

  return null;
}

export function ensureFreshRelease(options: ReleaseGuardOptions) {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof fetch !== "function") {
    return;
  }

  const releaseFileName = trimString(options.releaseFileName) ?? DEFAULT_RELEASE_FILE_NAME;
  const bundleScriptUrls = resolveBundleScriptUrls(options.bundleFileNames);
  const currentVersion = getCurrentVersion(bundleScriptUrls);
  const existingAttempt = readAttemptState(options.entry);

  if (existingAttempt) {
    if (currentVersion && currentVersion === existingAttempt.targetVersion) {
      clearAttemptState(options.entry);
    } else if (Date.now() - existingAttempt.attemptedAt > RELOAD_ATTEMPT_TTL_MS) {
      clearAttemptState(options.entry);
    }
  }

  cleanupReloadQuery(currentVersion);

  const manifestCandidates = buildManifestCandidates(bundleScriptUrls, releaseFileName);
  if (manifestCandidates.length === 0) {
    return;
  }

  void (async () => {
    const latestVersion = await resolveLatestVersion(manifestCandidates);
    if (!latestVersion || isLkIdleRequestPaused()) {
      return;
    }

    if (!currentVersion || isRuntimeCacheBusterVersion(currentVersion)) {
      window.__LK_RELEASE_VERSION__ = latestVersion;
      clearAttemptState(options.entry);
      return;
    }

    if (currentVersion === latestVersion) {
      window.__LK_RELEASE_VERSION__ = latestVersion;
      clearAttemptState(options.entry);
      cleanupReloadQuery(latestVersion);
      return;
    }

    const attemptState = readAttemptState(options.entry);
    if (
      attemptState
      && attemptState.targetVersion === latestVersion
      && Date.now() - attemptState.attemptedAt <= RELOAD_ATTEMPT_TTL_MS
    ) {
      return;
    }

    writeAttemptState(options.entry, {
      targetVersion: latestVersion,
      attemptedAt: Date.now(),
    });

    const reloadUrl = new URL(window.location.href);
    reloadUrl.searchParams.set(RELOAD_QUERY_KEY, latestVersion);
    window.location.replace(reloadUrl.toString());
  })();
}

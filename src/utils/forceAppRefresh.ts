import { TENANT_KEY } from "../consts/api_config";

const REFRESH_QUERY_KEY = "__lk_refresh";
const RELEASE_QUERY_KEY = "__lkv";
const REFRESH_STORAGE_KEY = "__lk_manual_refresh_requested_at";
const STORAGE_KEY_PREFIXES = [
  "__lk_",
  "__lk_release_guard_v1__",
  "padlhub.",
  `${TENANT_KEY}_lk_analytics_`,
] as const;
const LK_SCRIPT_FILE_NAMES = [
  "bundle.js",
  "games.js",
  "tournaments.js",
  "onboarding.js",
  "communities.js",
  "ffc-academy-lk.js",
  "bundle-dev.js",
  "games-dev.js",
  "tournaments-dev.js",
  "onboarding-dev.js",
  "communities-dev.js",
  "ffc-academy-lk-dev.js",
] as const;
const LK_RELEASE_FILE_NAMES = [
  "release.json",
  "release-dev.json",
  "release-ffc-academy.json",
  "release-ffc-academy-dev.json",
] as const;

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function matchesBundleScript(src: string): boolean {
  try {
    const parsed = new URL(src, window.location.href);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith("/bundle.js") || pathname.endsWith("/bundle-dev.js");
  } catch {
    const lowerSrc = src.toLowerCase();
    return lowerSrc.includes("bundle.js") || lowerSrc.includes("bundle-dev.js");
  }
}

function resolveCurrentBundleScriptUrl(): URL | null {
  if (typeof document === "undefined") return null;

  const scripts = Array.from(document.scripts).reverse();
  for (const script of scripts) {
    const src = trimString(script.src);
    if (!src || !matchesBundleScript(src)) continue;

    try {
      return new URL(src, window.location.href);
    } catch {
      // Try the next script.
    }
  }

  return null;
}

function resolveReleaseUrl(bundleUrl: URL | null): string {
  if (bundleUrl) {
    const releaseUrl = new URL(bundleUrl.toString());
    const fileName = releaseUrl.pathname.toLowerCase().endsWith("/bundle-dev.js")
      ? "release-dev.json"
      : "release.json";
    releaseUrl.pathname = releaseUrl.pathname.replace(/\/[^/]*$/, `/${fileName}`);
    releaseUrl.search = "";
    releaseUrl.hash = "";
    return releaseUrl.toString();
  }

  return new URL("/lk/release.json", window.location.origin).toString();
}

function resolveLkBaseUrl(bundleUrl: URL | null): URL {
  if (bundleUrl) {
    const baseUrl = new URL(bundleUrl.toString());
    baseUrl.pathname = baseUrl.pathname.replace(/\/[^/]*$/, "/");
    baseUrl.search = "";
    baseUrl.hash = "";
    return baseUrl;
  }

  return new URL("/lk/", window.location.origin);
}

function buildRefreshAssetUrls(bundleUrl: URL | null): string[] {
  const baseUrl = resolveLkBaseUrl(bundleUrl);
  const seen = new Set<string>();
  const addAsset = (fileName: string) => {
    const url = new URL(fileName, baseUrl);
    const key = url.toString();
    if (seen.has(key)) return null;
    seen.add(key);
    return key;
  };

  return [
    ...LK_RELEASE_FILE_NAMES,
    ...LK_SCRIPT_FILE_NAMES,
  ].map(addAsset).filter((value): value is string => Boolean(value));
}

async function deleteBrowserCaches() {
  if (typeof caches === "undefined" || typeof caches.keys !== "function") {
    return;
  }

  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // Browser cache APIs are best-effort only.
  }
}

function shouldClearStorageKey(key: string): boolean {
  return STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function clearStorageKeys(storage: Storage) {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || !shouldClearStorageKey(key)) continue;
    storage.removeItem(key);
  }
}

function clearReleaseGuardState() {
  try {
    const storages = [window.sessionStorage, window.localStorage].filter(Boolean);
    storages.forEach((storage) => {
      clearStorageKeys(storage);
    });
    window.sessionStorage.setItem(REFRESH_STORAGE_KEY, String(Date.now()));
  } catch {
    // Ignore private mode and storage quota failures.
  }
}

async function unregisterServiceWorkers() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // Service worker cleanup is best-effort only.
  }
}

type IndexedDbFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>;
};

function deleteIndexedDbDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function deleteIndexedDbDatabases() {
  if (typeof indexedDB === "undefined") {
    return;
  }

  const indexedDbFactory = indexedDB as IndexedDbFactoryWithDatabases;
  if (typeof indexedDbFactory.databases !== "function") {
    return;
  }

  try {
    const databases = await indexedDbFactory.databases();
    const names = Array.from(new Set(
      databases
        .map((database) => trimString(database.name))
        .filter((name): name is string => Boolean(name)),
    ));

    await Promise.all(names.map((name) => deleteIndexedDbDatabase(name)));
  } catch {
    // IndexedDB cleanup is best-effort only.
  }
}

async function fetchLatestReleaseVersion(releaseUrl: string): Promise<string | null> {
  if (typeof fetch !== "function") return null;

  try {
    const url = new URL(releaseUrl);
    url.searchParams.set("force_ts", `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const response = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { version?: unknown } | null;
    return trimString(payload?.version);
  } catch {
    return null;
  }
}

async function refreshAsset(url: string, cacheBust: string) {
  if (typeof fetch !== "function") return;

  try {
    const assetUrl = new URL(url, window.location.href);
    assetUrl.searchParams.set("force_ts", cacheBust);
    await fetch(assetUrl.toString(), {
      method: "GET",
      cache: "reload",
    });
  } catch {
    // Individual assets are refreshed best-effort; reload still proceeds.
  }
}

async function refreshAllKnownScripts(bundleUrl: URL | null) {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const assetUrls = buildRefreshAssetUrls(bundleUrl);
  await Promise.all(assetUrls.map((assetUrl) => refreshAsset(assetUrl, cacheBust)));
}

export async function forceAppRefresh() {
  if (typeof window === "undefined") return;

  const bundleUrl = resolveCurrentBundleScriptUrl();
  const releaseUrl = resolveReleaseUrl(bundleUrl);
  const latestVersion = await fetchLatestReleaseVersion(releaseUrl);

  await Promise.all([
    deleteBrowserCaches(),
    unregisterServiceWorkers(),
    deleteIndexedDbDatabases(),
  ]);
  await refreshAllKnownScripts(bundleUrl);
  clearReleaseGuardState();

  const reloadUrl = new URL(window.location.href);
  reloadUrl.searchParams.set(REFRESH_QUERY_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (latestVersion) {
    reloadUrl.searchParams.set(RELEASE_QUERY_KEY, latestVersion);
  }

  window.location.replace(reloadUrl.toString());
}

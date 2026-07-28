type ImportMetaEnvLike = ImportMeta & {
  env?: Record<string, string | undefined>;
};

type AssetFileCandidateOptions = {
  search?: string;
  hash?: string;
};

const DEFAULT_LK_BASE_PATH = "/lk";
const DEFAULT_PROJECT_LK_BASE_URLS = [
  "https://padlhub.su/lk",
  "https://lk-reserve.89-108-64-209.sslip.io/lk",
  "https://padlhub.ru/lk",
] as const;
const importMetaEnv = (import.meta as ImportMetaEnvLike).env;

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeBaseUrl(value: string | URL | null | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value).trim());
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || DEFAULT_LK_BASE_PATH;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeBaseUrlFromScriptSrc(value: string | URL | null | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value).trim());
    parsed.search = "";
    parsed.hash = "";

    const normalizedPathname = parsed.pathname.replace(/\/+/g, "/");
    const marker = `${DEFAULT_LK_BASE_PATH}/`;
    const markerIndex = normalizedPathname.indexOf(marker);
    if (markerIndex !== -1) {
      parsed.pathname = normalizedPathname.slice(0, markerIndex + DEFAULT_LK_BASE_PATH.length);
      return parsed.toString().replace(/\/+$/, "");
    }

    const trimmedPathname = normalizedPathname.replace(/\/+$/, "");
    if (trimmedPathname === DEFAULT_LK_BASE_PATH) {
      parsed.pathname = DEFAULT_LK_BASE_PATH;
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    return null;
  }

  return null;
}

function parseBaseUrlList(value: string | null | undefined): string[] {
  if (!value) return [];

  return value
    .split(/[\s,]+/)
    .map((item) => normalizeBaseUrl(item))
    .filter((item): item is string => Boolean(item));
}

function dedupeBaseUrls(values: Array<string | URL | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = normalizeBaseUrl(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}

const CONFIGURED_LK_FALLBACK_BASE_URLS = parseBaseUrlList(importMetaEnv?.VITE_LK_ASSET_FALLBACK_BASE_URLS);
const PROJECT_LK_BASE_URLS = dedupeBaseUrls([
  ...DEFAULT_PROJECT_LK_BASE_URLS,
  ...CONFIGURED_LK_FALLBACK_BASE_URLS,
]);
const PROJECT_LK_HOSTS = new Set(
  PROJECT_LK_BASE_URLS.flatMap((baseUrl) => {
    try {
      return [new URL(baseUrl).hostname];
    } catch {
      return [];
    }
  }),
);

function getWindowBaseUrls(): string[] {
  if (typeof window === "undefined" || !Array.isArray(window.__LK_BASE_URLS__)) {
    return [];
  }

  return dedupeBaseUrls(window.__LK_BASE_URLS__);
}

function detectDocumentScriptBaseUrl(): string | null {
  if (typeof document === "undefined") return null;

  const currentScript = document.currentScript as { src?: string | null } | null;
  const currentScriptBaseUrl = normalizeBaseUrlFromScriptSrc(trimString(currentScript?.src));
  if (currentScriptBaseUrl) return currentScriptBaseUrl;

  const scripts = Array.from(document.scripts || []);
  for (let index = scripts.length - 1; index >= 0; index -= 1) {
    const script = scripts[index] as { src?: string | null };
    const scriptBaseUrl = normalizeBaseUrlFromScriptSrc(trimString(script?.src));
    if (scriptBaseUrl) return scriptBaseUrl;
  }

  return null;
}

const INITIAL_ACTIVE_LK_BASE_URL = detectDocumentScriptBaseUrl();

function getActiveLkBaseUrl(): string | null {
  if (typeof window !== "undefined") {
    const activeBaseUrl = normalizeBaseUrl(window.__LK_ACTIVE_BASE_URL__);
    if (activeBaseUrl) return activeBaseUrl;
  }

  return INITIAL_ACTIVE_LK_BASE_URL ?? detectDocumentScriptBaseUrl();
}

function getCurrentOriginBaseUrls(seedBaseUrls: string[]): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  const baseUrls = seedBaseUrls.length > 0
    ? seedBaseUrls
    : [normalizeBaseUrl(new URL(DEFAULT_LK_BASE_PATH, window.location.origin).toString())];
  const seenPaths = new Set<string>();
  const result: string[] = [];

  baseUrls.forEach((baseUrl) => {
    if (!baseUrl) return;

    try {
      const parsed = new URL(baseUrl);
      const pathname = parsed.pathname || DEFAULT_LK_BASE_PATH;
      if (seenPaths.has(pathname)) return;
      seenPaths.add(pathname);

      const currentOriginBase = normalizeBaseUrl(new URL(pathname, window.location.origin).toString());
      if (currentOriginBase) {
        result.push(currentOriginBase);
      }
    } catch {
      // ignored
    }
  });

  return dedupeBaseUrls(result);
}

function isProjectBaseUrl(baseUrl: string): boolean {
  try {
    return PROJECT_LK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function buildFileUrl(baseUrl: string, fileName: string, search = "", hash = ""): string {
  const normalizedFileName = fileName.replace(/^\/+/, "");
  const url = new URL(normalizedFileName, `${baseUrl.replace(/\/+$/, "")}/`);
  url.search = search;
  url.hash = hash;
  return url.toString();
}

function extractProjectRelativePath(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+/g, "/");
  const marker = `${DEFAULT_LK_BASE_PATH}/`;
  const markerIndex = normalizedPathname.indexOf(marker);
  if (markerIndex === -1) return null;

  const relativePath = normalizedPathname.slice(markerIndex + marker.length).replace(/^\/+/, "");
  return relativePath || null;
}

export function resolveLkAssetBaseUrls(seedValues: Array<string | URL | null | undefined>): string[] {
  const seedBaseUrls = dedupeBaseUrls(seedValues);
  const activeBaseUrl = getActiveLkBaseUrl();
  const windowBaseUrls = getWindowBaseUrls();
  const hasExplicitRuntimeBaseUrls = seedBaseUrls.length > 0
    || windowBaseUrls.length > 0
    || Boolean(activeBaseUrl);
  const currentOriginBaseUrls = hasExplicitRuntimeBaseUrls
    ? []
    : getCurrentOriginBaseUrls(seedBaseUrls.length > 0 ? seedBaseUrls : windowBaseUrls);
  const shouldIncludeProjectBaseUrls = !hasExplicitRuntimeBaseUrls
    && (
      [
        ...seedBaseUrls,
        ...windowBaseUrls,
        ...currentOriginBaseUrls,
      ].some(isProjectBaseUrl)
      || (typeof window !== "undefined" && PROJECT_LK_HOSTS.has(window.location.hostname))
    );

  const preferredBaseUrls = activeBaseUrl
    ? [activeBaseUrl, ...windowBaseUrls, ...seedBaseUrls]
    : [...seedBaseUrls, ...windowBaseUrls];

  return dedupeBaseUrls([
    ...preferredBaseUrls,
    ...(hasExplicitRuntimeBaseUrls ? [] : CONFIGURED_LK_FALLBACK_BASE_URLS),
    ...(shouldIncludeProjectBaseUrls ? PROJECT_LK_BASE_URLS : []),
    ...currentOriginBaseUrls,
  ]);
}

export function buildLkAssetFileCandidates(
  fileName: string,
  seedValues: Array<string | URL | null | undefined>,
  options: AssetFileCandidateOptions = {},
): string[] {
  const normalizedFileName = trimString(fileName);
  if (!normalizedFileName) return [];

  const search = typeof options.search === "string" ? options.search : "";
  const hash = typeof options.hash === "string" ? options.hash : "";

  return resolveLkAssetBaseUrls(seedValues).map((baseUrl) =>
    buildFileUrl(baseUrl, normalizedFileName, search, hash),
  );
}

export function buildLkAssetUrlCandidates(src: string): string[] {
  const normalizedSrc = trimString(src);
  if (!normalizedSrc) return [];

  try {
    const baseUrl = typeof window !== "undefined" ? window.location.href : undefined;
    const resolved = new URL(normalizedSrc, baseUrl);
    const projectRelativePath = extractProjectRelativePath(resolved.pathname);
    if (projectRelativePath) {
      const projectBaseUrl = normalizeBaseUrl(new URL(DEFAULT_LK_BASE_PATH, resolved.origin).toString());
      if (projectBaseUrl) {
        return buildLkAssetFileCandidates(projectRelativePath, [projectBaseUrl], {
          search: resolved.search,
          hash: resolved.hash,
        });
      }
    }

    const fileName = resolved.pathname.split("/").pop() || "";
    const assetBaseUrl = normalizeBaseUrl(`${resolved.origin}${resolved.pathname.replace(/\/[^/]*$/, "")}`);
    return buildLkAssetFileCandidates(fileName, [assetBaseUrl], {
      search: resolved.search,
      hash: resolved.hash,
    });
  } catch {
    return [normalizedSrc];
  }
}

export function resolvePreferredLkAssetUrl(src: string): string | null {
  const candidates = buildLkAssetUrlCandidates(src);
  return candidates[0] ?? trimString(src);
}

export function resolveLkAssetBaseUrlFromScript(url: URL | null | undefined): string | null {
  if (!url) return null;

  const next = new URL(url.toString());
  next.search = "";
  next.hash = "";
  next.pathname = next.pathname.replace(/\/[^/]*$/, "");
  return normalizeBaseUrl(next);
}

type ImportMetaEnvLike = ImportMeta & {
  env?: Record<string, string | undefined>;
};

type ResolveLkApiBaseUrlOptions = {
  activeBaseUrl?: string | null;
  windowBaseUrls?: string[];
  windowApiBaseUrls?: string[];
};

const DEFAULT_LK_API_FALLBACK_BASE_URLS = [
  "https://lk-reserve.89-108-64-209.sslip.io",
] as const;
const DEFAULT_LK_BASE_PATH = "/lk";
const DEFAULT_SERV2_FALLBACK_TIMEOUT_MS = 2500;
const importMetaEnv = (import.meta as ImportMetaEnvLike).env;

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeOrigin(value: string | URL | null | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value).trim());
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeUrl(value: string | URL | null | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value).trim());
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeLkBaseUrl(value: string | URL | null | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = value instanceof URL ? new URL(value.toString()) : new URL(String(value).trim());
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/lk";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeLkBaseUrlFromScriptSrc(value: string | URL | null | undefined): string | null {
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

function parseOriginList(value: string | null | undefined): string[] {
  if (!value) return [];

  return value
    .split(/[\s,]+/)
    .map((item) => normalizeOrigin(item))
    .filter((item): item is string => Boolean(item));
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });

  return result;
}

function getHost(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function getWindowBaseUrls(): string[] {
  if (typeof window === "undefined" || !Array.isArray(window.__LK_BASE_URLS__)) {
    return [];
  }

  return window.__LK_BASE_URLS__.map((item) => normalizeLkBaseUrl(item)).filter(Boolean) as string[];
}

function getWindowApiBaseUrls(): string[] {
  if (typeof window === "undefined" || !Array.isArray(window.__LK_API_BASE_URLS__)) {
    return [];
  }

  return window.__LK_API_BASE_URLS__.map((item) => normalizeOrigin(item)).filter(Boolean) as string[];
}

function detectDocumentScriptLkBaseUrl(): string | null {
  if (typeof document === "undefined") return null;

  const currentScript = document.currentScript as { src?: string | null } | null;
  const currentScriptBaseUrl = normalizeLkBaseUrlFromScriptSrc(trimString(currentScript?.src));
  if (currentScriptBaseUrl) return currentScriptBaseUrl;

  const scripts = Array.from(document.scripts || []);
  for (let index = scripts.length - 1; index >= 0; index -= 1) {
    const script = scripts[index] as { src?: string | null };
    const scriptBaseUrl = normalizeLkBaseUrlFromScriptSrc(trimString(script?.src));
    if (scriptBaseUrl) return scriptBaseUrl;
  }

  return null;
}

const INITIAL_ACTIVE_LK_BASE_URL = detectDocumentScriptLkBaseUrl();

function getActiveLkBaseUrl(): string | null {
  if (typeof window !== "undefined") {
    const activeBaseUrl = normalizeLkBaseUrl(window.__LK_ACTIVE_BASE_URL__);
    if (activeBaseUrl) return activeBaseUrl;
  }

  return INITIAL_ACTIVE_LK_BASE_URL ?? detectDocumentScriptLkBaseUrl();
}

const CONFIGURED_LK_API_FALLBACK_BASE_URLS = parseOriginList(
  importMetaEnv?.VITE_LK_API_FALLBACK_BASE_URLS,
);
const CONFIGURED_LK_ASSET_FALLBACK_ORIGINS = parseOriginList(
  importMetaEnv?.VITE_LK_ASSET_FALLBACK_BASE_URLS,
);
const PROJECT_LK_API_FALLBACK_BASE_URLS = dedupeStrings([
  ...DEFAULT_LK_API_FALLBACK_BASE_URLS.map((item) => normalizeOrigin(item)),
  ...CONFIGURED_LK_API_FALLBACK_BASE_URLS,
  ...CONFIGURED_LK_ASSET_FALLBACK_ORIGINS,
]);

function buildKnownApiHosts(
  primaryServ2: string | null | undefined,
  fallbackServ2: string | null | undefined,
  options: ResolveLkApiBaseUrlOptions = {},
): Set<string> {
  const primaryOrigin = normalizeOrigin(primaryServ2);
  const fallbackOrigin = normalizeOrigin(fallbackServ2);
  const windowApiBaseUrls = options.windowApiBaseUrls ?? getWindowApiBaseUrls();

  return new Set(
    [
      primaryOrigin,
      fallbackOrigin,
      ...PROJECT_LK_API_FALLBACK_BASE_URLS,
      ...windowApiBaseUrls,
    ]
      .map((item) => getHost(item))
      .filter((item): item is string => Boolean(item)),
  );
}

export function resolveLkApiFallbackTimeoutMs(value?: string | number | null): number {
  const raw = value ?? importMetaEnv?.VITE_SERV2_FALLBACK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SERV2_FALLBACK_TIMEOUT_MS;
  return Math.max(500, Math.min(15_000, Math.floor(parsed)));
}

export function resolveLkApiBaseUrlCandidates(
  primaryServ2: string | null | undefined,
  fallbackServ2: string | null | undefined,
  options: ResolveLkApiBaseUrlOptions = {},
): string[] {
  const primaryOrigin = normalizeOrigin(primaryServ2);
  const fallbackOrigin = normalizeOrigin(fallbackServ2);
  const windowApiBaseUrls = options.windowApiBaseUrls ?? getWindowApiBaseUrls();
  const windowBaseUrls = options.windowBaseUrls ?? getWindowBaseUrls();

  const knownApiHosts = buildKnownApiHosts(primaryServ2, fallbackServ2, options);

  const assetApiOrigins = windowBaseUrls
    .map((item) => normalizeOrigin(item))
    .filter((item): item is string => {
      const host = getHost(item);
      return Boolean(host && knownApiHosts.has(host));
    });

  const activeOrigin = normalizeOrigin(options.activeBaseUrl ?? getActiveLkBaseUrl());
  const activeCandidate = (() => {
    const host = getHost(activeOrigin);
    return host && knownApiHosts.has(host) ? activeOrigin : null;
  })();

  return dedupeStrings([
    activeCandidate,
    primaryOrigin,
    fallbackOrigin,
    ...PROJECT_LK_API_FALLBACK_BASE_URLS,
    ...windowApiBaseUrls,
    ...assetApiOrigins,
  ]);
}

export function resolvePreferredLkApiBaseUrl(
  primaryServ2: string | null | undefined,
  fallbackServ2: string | null | undefined,
  options: ResolveLkApiBaseUrlOptions = {},
): string | null {
  const candidates = resolveLkApiBaseUrlCandidates(primaryServ2, fallbackServ2, options);
  return candidates[0] ?? normalizeOrigin(primaryServ2) ?? normalizeOrigin(fallbackServ2);
}

export function buildProjectUrlCandidates(
  targetUrl: string | URL | null | undefined,
  primaryServ2: string | null | undefined,
  fallbackServ2: string | null | undefined,
  options: ResolveLkApiBaseUrlOptions = {},
): string[] {
  const normalizedTargetUrl = normalizeUrl(targetUrl);
  if (!normalizedTargetUrl) return [];

  let parsedTargetUrl: URL;
  try {
    parsedTargetUrl = new URL(normalizedTargetUrl);
  } catch {
    return [normalizedTargetUrl];
  }

  const knownApiHosts = buildKnownApiHosts(primaryServ2, fallbackServ2, options);
  if (!knownApiHosts.has(parsedTargetUrl.hostname)) {
    return [normalizedTargetUrl];
  }

  const originCandidates = resolveLkApiBaseUrlCandidates(primaryServ2, fallbackServ2, options);
  const pathWithQueryAndHash = `${parsedTargetUrl.pathname}${parsedTargetUrl.search}${parsedTargetUrl.hash}`;

  return dedupeStrings([
    ...originCandidates.map((origin) => {
      try {
        return new URL(pathWithQueryAndHash, `${origin.replace(/\/+$/, "")}/`).toString();
      } catch {
        return null;
      }
    }),
    normalizedTargetUrl,
  ]);
}

export function resolvePreferredProjectUrl(
  targetUrl: string | URL | null | undefined,
  primaryServ2: string | null | undefined,
  fallbackServ2: string | null | undefined,
  options: ResolveLkApiBaseUrlOptions = {},
): string | null {
  const candidates = buildProjectUrlCandidates(targetUrl, primaryServ2, fallbackServ2, options);
  return candidates[0] ?? normalizeUrl(targetUrl);
}

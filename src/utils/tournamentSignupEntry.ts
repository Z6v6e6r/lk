const DEFAULT_PUBLIC_TOURNAMENT_ORIGIN = "https://padlhub.ru";
export const DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH = "/tournaments";

const LEGACY_PUBLIC_TOURNAMENT_SIGNUP_PATH = "/tournament_signup";
const LEGACY_PUBLIC_TOURNAMENT_API_PREFIX = "/api/tournaments/public/";
const SUPPORTED_PUBLIC_TOURNAMENT_PATHS = [
  DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH,
  LEGACY_PUBLIC_TOURNAMENT_SIGNUP_PATH,
] as const;

export type TournamentSignupEntryData = {
  tournamentId: string | null;
  tournamentSlug: string | null;
  date: string | null;
};

function normalizePublicPath(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  if (!normalized) return DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH;
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash.replace(/\/+$/, "") || DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH;
}

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.map((value) => String(value || "").trim()).find(Boolean) ?? null;
}

export function normalizeTournamentSignupSlug(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim().toLowerCase() || null;
  } catch {
    return raw.toLowerCase();
  }
}

export function normalizeTournamentSignupDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const isoDate = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function readTournamentSignupEntryDataFromHref(href: string): TournamentSignupEntryData {
  const current = new URL(href, DEFAULT_PUBLIC_TOURNAMENT_ORIGIN);
  return {
    tournamentId: firstNonEmpty(
      current.searchParams.get("tournamentId"),
      current.searchParams.get("id"),
      current.searchParams.get("exerciseId"),
    ),
    tournamentSlug: normalizeTournamentSignupSlug(
      current.searchParams.get("slug") || current.searchParams.get("tournamentSlug"),
    ),
    date: normalizeTournamentSignupDate(current.searchParams.get("date")),
  };
}

export function normalizeTournamentSignupPublicUrl(
  value: string | null | undefined,
  options: {
    publicOrigin?: string | null;
    publicPath?: string | null;
  } = {},
) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const publicOrigin = String(options.publicOrigin || "").trim() || DEFAULT_PUBLIC_TOURNAMENT_ORIGIN;
  const publicPath = normalizePublicPath(options.publicPath);

  try {
    const parsed = new URL(raw, publicOrigin);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    const rewritten = new URL(publicPath, parsed.origin);
    parsed.searchParams.forEach((paramValue, key) => {
      rewritten.searchParams.set(key, paramValue);
    });

    if (normalizedPath.startsWith(LEGACY_PUBLIC_TOURNAMENT_API_PREFIX)) {
      const slug = normalizedPath.slice(LEGACY_PUBLIC_TOURNAMENT_API_PREFIX.length).split("/").filter(Boolean)[0] ?? "";
      if (slug) rewritten.searchParams.set("slug", decodeURIComponent(slug));
      return rewritten.toString();
    }

    if (
      normalizedPath === publicPath
      || SUPPORTED_PUBLIC_TOURNAMENT_PATHS.includes(normalizedPath as typeof SUPPORTED_PUBLIC_TOURNAMENT_PATHS[number])
    ) {
      return rewritten.toString();
    }

    return parsed.toString();
  } catch {
    const legacyApiMatch = raw.match(/\/api\/tournaments\/public\/([^/?#]+)/i);
    if (legacyApiMatch?.[1]) {
      const rewritten = new URL(publicPath, publicOrigin);
      rewritten.searchParams.set("slug", decodeURIComponent(legacyApiMatch[1]));
      return rewritten.toString();
    }

    const legacyRouteMatch = raw.match(/\/(?:tournaments|tournament_signup)(?:[?#].*)?$/i);
    if (legacyRouteMatch) {
      try {
        const rewritten = new URL(raw.replace(/\/(?:tournaments|tournament_signup)(?=[?#]|$)/i, publicPath), publicOrigin);
        return rewritten.toString();
      } catch {
        return raw.replace(/\/(?:tournaments|tournament_signup)(?=[?#]|$)/i, publicPath);
      }
    }

    return raw;
  }
}

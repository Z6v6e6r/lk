const TRUSTED_PADLHUB_HOSTS = new Set([
  "padlhub.ru",
  "www.padlhub.ru",
  "padlhub.su",
  "www.padlhub.su",
]);

const POST_AUTH_RETURN_SOURCES = new Set([
  "game_join",
  "training_join",
  "tournament_join",
]);

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

export function resolveTrustedAuthReturnUrl(
  rawReturnUrl: string | null | undefined,
  currentHref: string,
): string | null {
  const raw = String(rawReturnUrl || "").trim();
  if (!raw || raw.length > 4096) return null;

  try {
    const currentUrl = new URL(currentHref);
    const returnUrl = new URL(raw, currentUrl.origin);
    const targetHost = returnUrl.hostname.toLowerCase();
    const targetIsLoopback = isLoopbackHostname(targetHost);
    const currentIsLoopback = isLoopbackHostname(currentUrl.hostname);

    if (returnUrl.username || returnUrl.password) return null;
    if (returnUrl.protocol !== "https:" && !(returnUrl.protocol === "http:" && targetIsLoopback)) {
      return null;
    }
    if (!TRUSTED_PADLHUB_HOSTS.has(targetHost) && !(currentIsLoopback && targetIsLoopback)) {
      return null;
    }
    if (returnUrl.toString() === currentUrl.toString()) return null;

    return returnUrl.toString();
  } catch {
    return null;
  }
}

export function readPostAuthReturnUrl(currentHref: string): string | null {
  try {
    const currentUrl = new URL(currentHref);
    const source = String(currentUrl.searchParams.get("source") || "").trim().toLowerCase();
    if (!POST_AUTH_RETURN_SOURCES.has(source)) return null;
    return resolveTrustedAuthReturnUrl(currentUrl.searchParams.get("returnUrl"), currentHref);
  } catch {
    return null;
  }
}

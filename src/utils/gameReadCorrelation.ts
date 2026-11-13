import { SERV2, SERV2_FALLBACK } from "../consts/api_config";
import { callerBuild } from "./errorDiagnostics";

export const CLIENT_REQUEST_ID_HEADER = "X-LK-Client-Request-ID";
export const CLIENT_BUILD_HEADER = "X-LK-Client-Build";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reserved = new Set(["available", "by-phone", "live-ratings", "records", "split", "payment", "confirm", "health"]);

// These headers describe one fetch attempt, never a person, game or business operation.
// Roll out CORS and edge logging before enabling this build option.
export function correlateGameReadRequest(
  headers: Headers, fullUrl: string, method = "GET", requestId?: string,
): boolean {
  headers.delete(CLIENT_REQUEST_ID_HEADER);
  headers.delete(CLIENT_BUILD_HEADER);
  try {
    if (import.meta.env.VITE_GAME_READ_DIAGNOSTICS !== "true" || method.toUpperCase() !== "GET"
      || !requestId || !requestIdPattern.test(requestId)) return false;
    const url = new URL(fullUrl);
    if (url.username || url.password || ![SERV2, SERV2_FALLBACK].some(origin => {
      try { return new URL(origin).origin === url.origin; } catch { return false; }
    })) return false;
    const match = /^\/lk\/games\/([A-Za-z0-9_-]+)(?:\/result\/state)?$/.exec(url.pathname);
    if (!match || reserved.has(match[1])) return false;
    const build = callerBuild();
    headers.set(CLIENT_REQUEST_ID_HEADER, requestId.toLowerCase());
    headers.set(CLIENT_BUILD_HEADER, /^[0-9a-f]{40}$/.test(build) ? build : "UNKNOWN");
    return true;
  } catch {
    // Diagnostics must not stop a request or leave a partial correlation claim.
    headers.delete(CLIENT_REQUEST_ID_HEADER);
    headers.delete(CLIENT_BUILD_HEADER);
    return false;
  }
}

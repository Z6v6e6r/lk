const lk = "https://padlhub.su";
const viva = "https://api.vivacrm.ru";
const id = "[a-zA-Z0-9_-]{1,128}";
const provider = "/end-user/api/v[12]/iSkq6G";
const masterServiceMetadata = new RegExp(`^/end-user/api/v1/iSkq6G/products/master-services/${id}/(meta|subServices|studios)$`);

const vivaEventOneTimeTariffs = /^\/end-user\/api\/v2\/iSkq6G\/products\/one-times$/;
const vivaExerciseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const get = [
  [viva, vivaEventOneTimeTariffs],
  [lk, /^\/lk\/onboarding\/stations$/],
  [lk, /^\/(?:seliger\/)?lk\/games$/],
  [lk, new RegExp(`^/(?:seliger/)?lk/games/${id}$`)],
  [lk, /^\/(?:seliger\/)?lk\/tournaments\/participants$/],
  [lk, new RegExp(`^/api/tournaments(?:/${id}(?:/registration/me)?)?$`)],
  [lk, /^\/(?:seliger\/)?lk\/games\/composite\/options$/],
  [viva, new RegExp(`^${provider}/(?:profile|studios|subscriptions|bookings(?:/history)?|exercises(?:/period)?|one-times/filter|products/subscriptions(?:/${id})?)$`)],
  [viva, /^\/api\/v1\/time$/],
  [viva, new RegExp(`^${provider}/products/master-services(?:/${id}(?:/price)?)?$`)],
  [viva, masterServiceMetadata],
  [viva, new RegExp(`^${provider}/exercises/${id}(?:/bookings)?$`)],
];
const post = [
  [lk, /^\/(?:seliger\/)?lk\/subscriptions\/game-price-preview$/],
  [viva, new RegExp(`^${provider}/transactions/preview$`)],
  [viva, new RegExp(`^${provider}/products/master-services/${id}/timeslots$`)],
];

export function readPilotTarget(value, method) {
  if (typeof value !== "string" || value.length > 4096 || !/^https:\/\//.test(value)
    || /[\\\s]/.test(value) || /%(?:2f|5c|2e|25)/i.test(value.split("?")[0])
    || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(value.split("?")[0])) return null;

  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash || url.port) return null;
  const rules = method === "GET" ? get : method === "POST" ? post : [];
  if (!rules.some(([origin, pattern]) => url.origin === origin && pattern.test(url.pathname))) return null;
  if (vivaEventOneTimeTariffs.test(url.pathname) && (url.searchParams.size !== 1
    || !vivaExerciseId.test(url.searchParams.get("exerciseId") ?? ""))) return null;
  if (url.pathname === "/lk/onboarding/stations" && url.search) return null;
  if (url.pathname === "/api/v1/time" && (url.searchParams.size !== 1 || !url.searchParams.get("timeZone"))) return null;
  const metadata = url.pathname.match(masterServiceMetadata)?.[1];
  if (metadata && url.search && (metadata !== "subServices" || url.searchParams.size !== 2
    || !new RegExp(`^${id}$`).test(url.searchParams.get("studioId") ?? "") || url.searchParams.get("showAll") !== "true")) return null;
  if (url.searchParams.has("pilotOffer") && (method !== "POST" || url.origin !== lk
    || url.pathname !== "/lk/subscriptions/game-price-preview" || url.searchParams.size !== 1
    || url.searchParams.get("pilotOffer") !== "ra-boost")) return null;
  const game = url.pathname.match(/^\/(?:seliger\/)?lk\/games(?:\/([^/]+))?$/);
  if (game) {
    if (game[1]) {
      if (url.search || ["by-phone", "composite", "split", "result", "bookings"].includes(game[1].toLowerCase())) return null;
    } else {
      const publicKeys = new Set(["public", "available", "limit", "offset", "date", "stationId", "studioId",
        "stationName", "studioName", "_ts"]);
      if (url.searchParams.get("public") !== "true" || [...url.searchParams.keys()].some((key) =>
        !publicKeys.has(key) || url.searchParams.getAll(key).length !== 1)) return null;
    }
  }
  for (const key of url.searchParams.keys()) {
    if (!/^[_a-z][a-z0-9_.-]{0,63}$/i.test(key) || /^(?:action|refresh|force|write|commit|create|payment)$/i.test(key)) {
      return null;
    }
  }
  return url;
}

export function isPilotPostBodyAllowed(target, body) {
  if (!body || Array.isArray(body) || typeof body !== "object") return false;
  if (target.origin !== lk) return true;

  if (target.searchParams.has("pilotOffer") ? Object.keys(body).length !== 1 || !Object.hasOwn(body, "target")
    : !Object.keys(body).every((key) => key === "target" || key === "subscriptionIds")) return false;
  const selection = body.target;
  if (!selection || Array.isArray(selection) || typeof selection !== "object") return false;
  const shapes = {
    NEW_GAME: ["targetKind", "slotId", "stationId", "roomId", "masterServiceId", "subServiceIds", "startsAt", "durationMinutes", "shareCount"],
    EXISTING_GAME: ["targetKind", "gameId", "startsAt", "durationMinutes"],
    GROUP_TRAINING: ["targetKind", "exerciseId"],
    TOURNAMENT: ["targetKind", "exerciseId"],
  };
  const shape = Object.hasOwn(shapes, selection.targetKind) && shapes[selection.targetKind];
  if (!shape || Object.keys(selection).length !== shape.length || !shape.every((key) => Object.hasOwn(selection, key))) {
    return false;
  }
  return body.subscriptionIds === undefined || Array.isArray(body.subscriptionIds)
    && body.subscriptionIds.length <= 30 && body.subscriptionIds.every((value) =>
      typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
}

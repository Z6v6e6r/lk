export const pilotScreens = {
  "game-booking": "Создать игру",
  "game-list": "Поиск игр",
  "game-join": "Карточка игры",
  "training-booking": "Расписание тренировок",
  "training-join": "Карточка тренировки",
  "tournament-booking": "Афиша турниров",
  "tournament-join": "Карточка турнира",
  matrix: "Способы записи",
} as const;

export type PilotScreen = keyof typeof pilotScreens;

export function pilotHref(screen: PilotScreen, params: URLSearchParams = new URLSearchParams()): string {
  const query = new URLSearchParams(params);
  query.set("screen", screen);
  return `/lk_pilot?${query}`;
}

function validEventId(value: string | null): string | null {
  return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !value.startsWith("demo-") ? value : null;
}

export function readPilotScreen(params: URLSearchParams) {
  const screen = params.get("screen") ?? "game-list";
  const date = params.get("date");
  return {
    screen: Object.hasOwn(pilotScreens, screen) ? screen as PilotScreen : "game-list" as const,
    eventId: validEventId(params.get("eventId")),
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
  };
}

export function resolvePilotNavigation(raw: unknown, current: string): string | null {
  if (typeof raw !== "string" && !(raw instanceof URL)) return null;
  let url: URL;
  try {
    url = new URL(raw, current);
  } catch {
    return null;
  }
  if (url.username || url.password || url.origin !== new URL(current).origin
    && url.origin !== "https://padlhub.ru") return null;
  const params = new URLSearchParams();
  for (const key of ["eventId", "date", "authMode", "studioId"]) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const gameId = validEventId(url.searchParams.get("joinGame"));
  const exerciseId = validEventId(url.searchParams.get("exerciseId"));
  const tournamentId = validEventId(url.searchParams.get("tournamentId"));
  if (gameId) {
    params.set("eventId", gameId);
    return pilotHref("game-join", params);
  }
  if (url.pathname === "/lk_pilot") {
    if (!url.searchParams.has("screen")) return pilotHref("game-list", params);
    const screen = readPilotScreen(url.searchParams);
    return pilotHref(screen.screen, params);
  }
  if (url.pathname === "/lk_new" || url.pathname === "/finde_game") return pilotHref("game-list", params);
  if (url.pathname === "/game_create") return pilotHref("game-booking", params);
  if (["/group", "/group_schedule"].includes(url.pathname)) {
    if (!exerciseId) return pilotHref("training-booking", params);
    params.set("eventId", exerciseId);
    return pilotHref("training-join", params);
  }
  if (url.pathname === "/tournaments") {
    const id = tournamentId ?? exerciseId;
    if (!id) return pilotHref("tournament-booking", params);
    params.set("eventId", id);
    return pilotHref("tournament-join", params);
  }
  return null;
}

export function navigateWithinPilot(input: unknown, replace = false) {
  const href = resolvePilotNavigation(input, window.location.href);
  if (!href) return;
  if (replace) window.location.replace(href);
  else window.location.assign(href);
}

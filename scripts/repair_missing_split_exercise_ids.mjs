#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};

const hasFlag = (name) => argv.includes(name);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const isObj = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const asArray = (value) => (Array.isArray(value) ? value : []);

const uniq = (values) => Array.from(new Set(values.filter(Boolean)));

const splitCsv = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitCsv(item));
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const showHelp = hasFlag("--help") || hasFlag("-h");
const apply = hasFlag("--apply");
const dryRun = !apply;
const verbose = hasFlag("--verbose");
const noViva = hasFlag("--no-viva");

const lkBase = toStr(getArg("--lk-base", process.env.LK_BASE || "https://padlhub.su/lk")) || "https://padlhub.su/lk";
const limit = Math.max(1, Math.min(1000, Math.floor(toNum(getArg("--limit", 500)) || 500)));
const maxPages = Math.max(1, Math.min(2000, Math.floor(toNum(getArg("--max-pages", 500)) || 500)));
const includePast = !hasFlag("--future-only");
const stationId = toStr(getArg("--station-id"));
const date = toStr(getArg("--date"));
const gameIdsFilter = new Set(
  uniq([
    ...splitCsv(getArg("--game-id")),
    ...splitCsv(getArg("--game-ids")),
  ]),
);

const vivaTokenUrl = toStr(getArg("--viva-token-url", process.env.VIVA_TOKEN_URL || "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token"))
  || "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const vivaApiBase = toStr(getArg("--viva-api-base", process.env.VIVA_API_BASE || "https://api.vivacrm.ru/api/v1"))
  || "https://api.vivacrm.ru/api/v1";
const vivaClientId = toStr(getArg("--viva-client-id", process.env.VIVA_CLIENT_ID || "React-auth-dev")) || "React-auth-dev";
const vivaUsername = toStr(getArg("--viva-username", process.env.VIVA_USERNAME || "it@citysport.pro")) || "it@citysport.pro";
const vivaPassword = toStr(getArg("--viva-password", process.env.VIVA_PASSWORD || "mhF-ma6-4Ju-QsJ")) || "mhF-ma6-4Ju-QsJ";

const nowIso = new Date().toISOString();
const nowSlug = nowIso.replace(/[:.]/g, "-");
const outPath = path.resolve(toStr(getArg("--out", `tmp/split-exerciseid-repair-${nowSlug}.json`)) || `tmp/split-exerciseid-repair-${nowSlug}.json`);

if (showHelp) {
  console.log(`
repair_missing_split_exercise_ids

Проверяет публичные игры со split-оплатой, ищет записи без exerciseId и восстанавливает:
1) из dedupeKey вида viva:<exerciseId>,
2) через Viva booking API: /clients/{clientId}/bookings/{bookingId}.

Usage:
  node scripts/repair_missing_split_exercise_ids.mjs [options]

Options:
  --apply                     Применить PATCH в lk (по умолчанию dry-run)
  --lk-base <url>             База LK API (default: https://padlhub.su/lk)
  --limit <n>                 Размер страницы games (default: 500)
  --max-pages <n>             Максимум страниц (default: 500)
  --future-only               Не включать прошлые игры
  --station-id <uuid>         Ограничить по студии
  --date <YYYY-MM-DD>         Ограничить по дате
  --game-id <id>              Одна игра (можно CSV)
  --game-ids <id1,id2>        Список игр
  --out <path>                Путь отчета
  --verbose                   Лог по играм
  --no-viva                   Не делать запросы в Viva (восстановление только из dedupeKey)

Viva options:
  --viva-token-url <url>
  --viva-api-base <url>
  --viva-client-id <id>
  --viva-username <user>
  --viva-password <pass>
`);
  process.exit(0);
}

if (!vivaClientId || !vivaUsername || !vivaPassword) {
  console.error("Missing Viva credentials (--viva-client-id, --viva-username, --viva-password)");
  process.exit(1);
}

const fetchJsonStrict = async (url, options = {}) => {
  const response = await fetch(url, options);
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
};

const fetchJsonAny = async (url, options = {}) => {
  const response = await fetch(url, options);
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }
  return { ok: response.ok, status: response.status, payload: parsed };
};

const hasSplitSignal = (game) => {
  const payMode = String(game?.settings?.payMode || "").trim().toLowerCase();
  if (payMode === "split") return true;
  const split = isObj(game?.metadata?.splitPayment) ? game.metadata.splitPayment : null;
  if (!split) return false;
  if (split.enabled === true) return true;
  if (Array.isArray(split.payments) && split.payments.length > 0) return true;
  const shareCount = Math.floor(toNum(split.shareCount) || 0);
  if (shareCount >= 2) return true;
  return false;
};

const resolveExistingExerciseId = (game) => {
  const booking = isObj(game?.booking) ? game.booking : {};
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const split = isObj(metadata?.splitPayment) ? metadata.splitPayment : {};
  return (
    toStr(split.vivaExerciseId)
    || toStr(split.exerciseId)
    || toStr(split.viva_exercise_id)
    || toStr(split.exercise_id)
    || toStr(booking.vivaExerciseId)
    || toStr(booking.exerciseId)
    || toStr(metadata.vivaExerciseId)
    || toStr(metadata.exerciseId)
    || null
  );
};

const resolveExerciseIdFromDedupe = (game) => {
  const key = toStr(game?.dedupeKey);
  if (!key) return null;
  const matched = key.match(/^viva:([0-9a-fA-F-]{16,})$/);
  return matched ? matched[1] : null;
};

const extractBookingIds = (game) => {
  const booking = isObj(game?.booking) ? game.booking : {};
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const split = isObj(metadata?.splitPayment) ? metadata.splitPayment : {};
  const payments = asArray(split.payments).filter((item) => isObj(item));

  const ids = [];
  ids.push(toStr(booking.bookingId));
  ids.push(...asArray(booking.bookingIds).map((item) => toStr(item)));
  ids.push(toStr(metadata.bookingId));
  ids.push(...asArray(metadata.bookingIds).map((item) => toStr(item)));
  ids.push(toStr(split.bookingId));
  ids.push(toStr(split.organizerBookingId));
  ids.push(...asArray(split.bookingIds).map((item) => toStr(item)));
  ids.push(...asArray(split.booking_ids).map((item) => toStr(item)));
  for (const payment of payments) {
    ids.push(toStr(payment.bookingId));
    ids.push(...asArray(payment.bookingIds).map((item) => toStr(item)));
  }
  return uniq(ids);
};

const extractKnownClientIds = (game) => {
  const organizer = isObj(game?.organizer) ? game.organizer : {};
  const booking = isObj(game?.booking) ? game.booking : {};
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const split = isObj(metadata?.splitPayment) ? metadata.splitPayment : {};
  const participants = asArray(game?.participants).filter((item) => isObj(item));
  const waitlist = asArray(game?.waitlist).filter((item) => isObj(item));
  const payments = asArray(split.payments).filter((item) => isObj(item));

  const ids = [];
  ids.push(toStr(organizer.id));
  ids.push(toStr(metadata.organizerId));
  ids.push(toStr(booking.clientId));
  for (const item of participants) ids.push(toStr(item.id));
  for (const item of waitlist) ids.push(toStr(item.id));
  for (const item of payments) {
    ids.push(toStr(item.clientId));
    ids.push(toStr(item.playerId));
    ids.push(toStr(item.userId));
  }
  return uniq(ids);
};

const extractPhones = (game) => {
  const organizer = isObj(game?.organizer) ? game.organizer : {};
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const split = isObj(metadata?.splitPayment) ? metadata.splitPayment : {};
  const participants = asArray(game?.participants).filter((item) => isObj(item));
  const waitlist = asArray(game?.waitlist).filter((item) => isObj(item));
  const payments = asArray(split.payments).filter((item) => isObj(item));

  const phones = [];
  phones.push(normalizePhone(organizer.phone || organizer.phoneNorm));
  phones.push(normalizePhone(metadata.organizerPhone || metadata.organizerPhoneNorm));
  for (const item of participants) phones.push(normalizePhone(item.phone || item.phoneNorm));
  for (const item of waitlist) phones.push(normalizePhone(item.phone || item.phoneNorm));
  for (const item of payments) {
    phones.push(normalizePhone(item.phone || item.phoneNorm || item.clientPhone || item.clientPhoneNorm));
  }
  return uniq(phones);
};

const fetchVivaToken = async () => {
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("client_id", vivaClientId);
  params.set("username", vivaUsername);
  params.set("password", vivaPassword);
  const payload = await fetchJsonStrict(vivaTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const token = toStr(payload?.access_token);
  if (!token) throw new Error("Viva token response has no access_token");
  return token;
};

const parseClientList = (payload) => {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.content)
      ? payload.content
      : (Array.isArray(payload?.data) ? payload.data : []));
  return list
    .filter((item) => isObj(item))
    .map((item) => toStr(item.id || item.clientId || item.uuid))
    .filter(Boolean);
};

const resolveExerciseIdFromBookingPayload = (payload) => (
  toStr(payload?.exerciseId)
  || toStr(payload?.exercise?.id)
  || toStr(payload?.exerciseUUID)
  || toStr(payload?.exerciseUuid)
  || null
);

const main = async () => {
  const report = {
    createdAt: nowIso,
    dryRun,
    apply,
    options: {
      lkBase,
      limit,
      maxPages,
      includePast,
      noViva,
      stationId,
      date,
      gameIds: Array.from(gameIdsFilter),
    },
    scannedGames: 0,
    scannedSplitGames: 0,
    missingExerciseCandidates: 0,
    repaired: [],
    unresolved: [],
    errors: [],
    stats: {
      repairedFromDedupe: 0,
      repairedFromViva: 0,
      patched: 0,
      patchFailed: 0,
      vivaTokenRequests: 0,
      vivaClientLookupRequests: 0,
      vivaBookingLookupRequests: 0,
      pagesLoaded: 0,
    },
  };

  const bookingLookupCache = new Map();
  const phoneToClientIdsCache = new Map();
  let vivaToken = null;

  const ensureVivaToken = async () => {
    if (vivaToken) return vivaToken;
    report.stats.vivaTokenRequests += 1;
    vivaToken = await fetchVivaToken();
    return vivaToken;
  };

  const fetchClientIdsByPhone = async (phone) => {
    if (!phone) return [];
    if (phoneToClientIdsCache.has(phone)) return phoneToClientIdsCache.get(phone) || [];
    const token = await ensureVivaToken();
    report.stats.vivaClientLookupRequests += 1;
    const url = `${vivaApiBase}/clients?phone=${encodeURIComponent(phone)}&size=50`;
    const response = await fetchJsonAny(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      phoneToClientIdsCache.set(phone, []);
      return [];
    }
    const ids = uniq(parseClientList(response.payload));
    phoneToClientIdsCache.set(phone, ids);
    return ids;
  };

  const fetchExerciseByClientBooking = async (clientId, bookingId) => {
    const key = `${clientId}|${bookingId}`;
    if (bookingLookupCache.has(key)) return bookingLookupCache.get(key);
    const token = await ensureVivaToken();
    report.stats.vivaBookingLookupRequests += 1;
    const url = `${vivaApiBase}/clients/${encodeURIComponent(clientId)}/bookings/${encodeURIComponent(bookingId)}`;
    const response = await fetchJsonAny(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const result = {
      ok: response.ok,
      status: response.status,
      exerciseId: response.ok ? resolveExerciseIdFromBookingPayload(response.payload) : null,
      payload: response.payload,
    };
    bookingLookupCache.set(key, result);
    return result;
  };

  const resolveViaViva = async (game) => {
    const bookingIds = extractBookingIds(game);
    if (bookingIds.length === 0) {
      return { exerciseId: null, method: "viva", reason: "no_booking_ids" };
    }

    let candidateClientIds = extractKnownClientIds(game);
    const phones = extractPhones(game);
    for (const phone of phones) {
      const ids = await fetchClientIdsByPhone(phone);
      candidateClientIds = uniq([...candidateClientIds, ...ids]);
    }

    if (candidateClientIds.length === 0) {
      return { exerciseId: null, method: "viva", reason: "no_client_ids" };
    }

    for (const bookingId of bookingIds) {
      for (const clientId of candidateClientIds) {
        const result = await fetchExerciseByClientBooking(clientId, bookingId);
        if (!result.ok) continue;
        if (result.exerciseId) {
          return {
            exerciseId: result.exerciseId,
            method: "viva",
            bookingId,
            clientId,
          };
        }
      }
    }

    return {
      exerciseId: null,
      method: "viva",
      reason: "not_found",
      triedBookingIds: bookingIds.length,
      triedClientIds: candidateClientIds.length,
    };
  };

  const loadPage = async (offset) => {
    const params = new URLSearchParams();
    params.set("public", "true");
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (includePast) {
      params.set("includePast", "true");
      params.set("past", "true");
    }
    if (stationId) params.set("stationId", stationId);
    if (date) params.set("date", date);
    const url = `${lkBase}/games?${params.toString()}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await fetchJsonStrict(url, { method: "GET" });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retriable = /HTTP (429|500|502|503|504)\b/.test(message);
        if (!retriable || attempt === 4) break;
        const waitMs = attempt * 800;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const patchGame = async (game, exerciseId) => {
    const gameId = toStr(game?.id);
    if (!gameId) throw new Error("Game has no id");
    const booking = isObj(game?.booking) ? game.booking : {};
    const nextBooking = {
      ...booking,
      exerciseId,
      vivaExerciseId: exerciseId,
    };
    const url = `${lkBase}/games/${encodeURIComponent(gameId)}`;
    return fetchJsonStrict(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking: nextBooking }),
    });
  };

  let offset = 0;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await loadPage(offset);
    const games = Array.isArray(page?.games) ? page.games.filter((item) => isObj(item)) : [];
    report.stats.pagesLoaded += 1;
    if (games.length === 0) break;

    for (const game of games) {
      const gameId = toStr(game.id);
      if (!gameId) continue;
      if (gameIdsFilter.size > 0 && !gameIdsFilter.has(gameId)) continue;

      report.scannedGames += 1;
      if (!hasSplitSignal(game)) continue;
      report.scannedSplitGames += 1;

      const existingExerciseId = resolveExistingExerciseId(game);
      if (existingExerciseId) continue;

      report.missingExerciseCandidates += 1;

      let resolvedExerciseId = null;
      let resolvedBy = null;
      let trace = {};

      const fromDedupe = resolveExerciseIdFromDedupe(game);
      if (fromDedupe) {
        resolvedExerciseId = fromDedupe;
        resolvedBy = "dedupe";
        trace = { dedupeKey: toStr(game.dedupeKey) };
        report.stats.repairedFromDedupe += 1;
      } else {
        if (noViva) {
          report.unresolved.push({
            gameId,
            reason: "viva_disabled",
            bookingDate: toStr(game?.booking?.date),
            studioId: toStr(game?.booking?.studioId),
            dedupeKey: toStr(game?.dedupeKey),
          });
          if (verbose) {
            console.log(`[missing] game=${gameId} unresolved viva_disabled`);
          }
          continue;
        }
        try {
          const viaViva = await resolveViaViva(game);
          if (viaViva.exerciseId) {
            resolvedExerciseId = viaViva.exerciseId;
            resolvedBy = "viva";
            trace = viaViva;
            report.stats.repairedFromViva += 1;
          } else {
            report.unresolved.push({
              gameId,
              reason: viaViva.reason || "viva_lookup_failed",
              bookingDate: toStr(game?.booking?.date),
              studioId: toStr(game?.booking?.studioId),
              dedupeKey: toStr(game?.dedupeKey),
              details: viaViva,
            });
          }
        } catch (error) {
          report.errors.push({
            gameId,
            stage: "viva_lookup",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!resolvedExerciseId) {
        if (verbose) {
          console.log(`[missing] game=${gameId} unresolved`);
        }
        continue;
      }

      const repairEntry = {
        gameId,
        bookingDate: toStr(game?.booking?.date),
        studioId: toStr(game?.booking?.studioId),
        dedupeKey: toStr(game?.dedupeKey),
        exerciseId: resolvedExerciseId,
        resolvedBy,
        trace,
        patched: false,
        patchError: null,
      };

      if (apply) {
        try {
          const patched = await patchGame(game, resolvedExerciseId);
          const persistedId = resolveExistingExerciseId(patched);
          repairEntry.patched = persistedId === resolvedExerciseId;
          if (!repairEntry.patched) {
            repairEntry.patchError = "patched_but_value_not_persisted";
            report.stats.patchFailed += 1;
          } else {
            report.stats.patched += 1;
          }
        } catch (error) {
          repairEntry.patchError = error instanceof Error ? error.message : String(error);
          report.stats.patchFailed += 1;
        }
      }

      report.repaired.push(repairEntry);
      if (verbose) {
        const suffix = apply ? (repairEntry.patched ? "patched" : `patch_failed:${repairEntry.patchError}`) : "dry-run";
        console.log(`[repair] game=${gameId} via=${resolvedBy} ${suffix}`);
      }
    }

    if (games.length < limit) break;
    offset += limit;
  }

  report.summary = {
    scannedGames: report.scannedGames,
    scannedSplitGames: report.scannedSplitGames,
    missingExerciseCandidates: report.missingExerciseCandidates,
    resolved: report.repaired.length,
    unresolved: report.unresolved.length,
    errors: report.errors.length,
    patched: report.stats.patched,
    patchFailed: report.stats.patchFailed,
    dryRun,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    apply,
    dryRun,
    summary: report.summary,
    report: outPath,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
// Read-only divergence audit for LK games versus the provider roster.
//
// A game can keep a participant that the provider no longer holds. Such a
// participant cannot leave the game on the old flow: the leave saga finds no
// live booking, cannot anchor a membership generation and answers 409 while
// persisting nothing. This script reports those pairs so the state can be
// verified before and after a release.
//
// It performs GET requests only. It never patches a game, cancels a booking,
// releases a claim or writes to Mongo.
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { reconcileRosterWithViva } from "../src/components/games/rosterSyncReconcile.ts";
import type { PadelGamePlayer, PadelGameRecord } from "../src/utils/apiClient.ts";

const DEFAULTS = Object.freeze({
  apiOrigin: "https://padlhub.su",
  participantsPath: "/lk/tournaments/participants",
  gamesPath: "/lk/games",
});
const REQUEST_TIMEOUT_MS = 20_000;

type Args = {
  phone: string;
  gameIds: string[];
  apiOrigin: string;
  includePast: boolean;
  limit: number | null;
  json: boolean;
  redact: boolean;
  spacingMs: number;
};

export const USAGE = "Usage: node --experimental-strip-types scripts/audit_games_roster_divergence.ts "
  + "(--phone <digits> | --game <gameId>)... "
  + "[--origin https://padlhub.su] [--include-past] [--limit N] [--spacing MS] [--json] [--redact]";

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

// Throwing variant so the parser stays testable; the CLI wrapper turns any
// failure into the usage message.
export function parseArgsOrThrow(argv: string[]): Args {
  const args: Args = {
    phone: "",
    gameIds: [],
    apiOrigin: DEFAULTS.apiOrigin,
    includePast: false,
    limit: null,
    json: false,
    redact: false,
    spacingMs: 400,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value");
      index += 1;
      return value;
    };
    if (flag === "--phone") args.phone = next().replace(/\D/g, "");
    else if (flag === "--game") args.gameIds.push(next().trim());
    else if (flag === "--origin") args.apiOrigin = next().replace(/\/+$/, "");
    else if (flag === "--include-past") args.includePast = true;
    else if (flag === "--limit") {
      const parsed = Number(next());
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Invalid limit");
      args.limit = parsed;
    } else if (flag === "--spacing") {
      const parsed = Number(next());
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid spacing");
      args.spacingMs = Math.floor(parsed);
    } else if (flag === "--json") args.json = true;
    else if (flag === "--redact") args.redact = true;
    else throw new Error("Unknown flag");
  }
  if (!args.phone && args.gameIds.length === 0) throw new Error("No target");
  return args;
}

export function parseArgs(argv: string[]): Args {
  try {
    return parseArgsOrThrow(argv);
  } catch {
    usage();
  }
}

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The LK surface is rate limited per client, so provider reads are serialized with
// a small spacing and retried on 429/5xx. Read-only: no request mutates anything.
async function getJson(url: string, options: { spacingMs?: number; retries?: number } = {}): Promise<unknown> {
  const spacingMs = options.spacingMs ?? 0;
  const retries = options.retries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    if (spacingMs > 0) await sleep(spacingMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let status = 0;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      status = response.status;
      if (response.ok) return await response.json();
      if (![429, 500, 502, 503, 504].includes(status)) throw new Error(`GET ${url} -> ${status}`);
    } catch (error) {
      if (error instanceof Error && /-> \d+$/.test(error.message)) throw error;
      if (attempt >= retries) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt >= retries) throw new Error(`GET ${url} -> ${status || "network error"}`);
    await sleep(Math.min(8_000, 500 * 2 ** attempt));
  }
}

export function extractGames(payload: unknown): PadelGameRecord[] {
  if (Array.isArray(payload)) return payload as PadelGameRecord[];
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  for (const key of ["games", "items", "content", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return value as PadelGameRecord[];
  }
  return [];
}

function resolveExerciseId(game: PadelGameRecord): string | null {
  const booking = game.booking;
  const metadata = game.metadata && typeof game.metadata === "object"
    ? game.metadata as Record<string, unknown>
    : null;
  const splitPayment = metadata?.splitPayment && typeof metadata.splitPayment === "object"
    ? metadata.splitPayment as Record<string, unknown>
    : null;
  const candidate = booking?.vivaExerciseId
    || booking?.exerciseId
    || (typeof splitPayment?.vivaExerciseId === "string" ? splitPayment.vivaExerciseId : null)
    || (typeof metadata?.vivaExerciseId === "string" ? metadata.vivaExerciseId : null)
    || (typeof metadata?.exerciseId === "string" ? metadata.exerciseId : null);
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

// The provider rows for this LK surface only guarantee an exercise id, so the
// booking rows are attributed to the exercise before identity matching.
export function toVivaPlayers(payload: unknown, exerciseId: string): PadelGamePlayer[] {
  const rows = Array.isArray(payload)
    ? payload
    : (() => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      for (const key of ["content", "data", "items", "rows"]) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
      }
      return [];
    })();
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .filter((row) => {
      const exercise = row.exercise && typeof row.exercise === "object"
        ? row.exercise as Record<string, unknown>
        : null;
      const rowExerciseId = exercise?.id ?? row.exerciseId ?? row.vivaExerciseId;
      return typeof rowExerciseId === "string" && rowExerciseId.trim() === exerciseId;
    })
    .filter((row) => {
      const status = String(row.bookingStatus ?? row.status ?? row.state ?? "").trim().toUpperCase();
      const cancelled = row.isCancelled === true
        || row.cancelled === true
        || row.canceled === true
        || Boolean(row.cancellationDate || row.cancelledAt || row.canceledAt)
        || /CANCEL/.test(status);
      return !cancelled && status !== "WAITLIST";
    })
    .map((row) => {
      const client = row.client && typeof row.client === "object" ? row.client as Record<string, unknown> : null;
      const id = client?.id ?? row.clientId ?? row.playerId ?? row.userId ?? null;
      const phone = client?.phone ?? row.phone ?? row.clientPhone ?? null;
      const firstName = typeof client?.firstName === "string" ? client.firstName : "";
      const lastName = typeof client?.lastName === "string" ? client.lastName : "";
      const name = [firstName, lastName].filter(Boolean).join(" ").trim()
        || (typeof client?.name === "string" ? client.name : "")
        || (typeof row.clientName === "string" ? row.clientName : "Игрок");
      return {
        id: typeof id === "string" && id.trim() ? id.trim() : null,
        name,
        phone: normalizePhone(typeof phone === "string" ? phone : null),
        photo: null,
        rating: null,
        ratingNumeric: null,
      } satisfies PadelGamePlayer;
    });
}

export type DivergenceFinding = {
  gameId: string;
  exerciseId: string;
  status: string;
  date: string | null;
  startTime: string | null;
  sourceParticipantsCount: number;
  vivaParticipantsCount: number;
  lkOnlyParticipants: Array<{ id: string | null; name: string | null; phone: string | null; source: string | null }>;
  vivaOnlyParticipants: Array<{ id: string | null; name: string | null }>;
  verdict: "phantom_participant" | "lk_behind_provider" | "aligned";
};

export function evaluateGame(
  game: PadelGameRecord,
  exerciseId: string,
  vivaPlayers: PadelGamePlayer[],
  options: { redact?: boolean } = {},
): DivergenceFinding {
  const sourceParticipants = (game.participants ?? []).filter((player) => {
    const status = String(player.status || "").trim().toUpperCase();
    return status !== "LEFT" && status !== "REMOVED" && status !== "WAITLIST";
  });
  const reconciliation = reconcileRosterWithViva({
    sourceParticipants,
    vivaParticipants: vivaPlayers,
    leaveEvents: [],
    organizerPlayer: game.organizer ?? undefined,
    authoritative: true,
  });
  const kept = new Set(reconciliation.mergedCandidates.map((player) => player.id || player.name));
  const lkOnly = sourceParticipants.filter((player) => !kept.has(player.id || player.name));
  const vivaOnly = vivaPlayers.filter((vivaPlayer) => !sourceParticipants.some((player) => (
    (vivaPlayer.id && player.id && vivaPlayer.id === player.id)
    || (normalizePhone(vivaPlayer.phone) && normalizePhone(vivaPlayer.phone) === normalizePhone(player.phone))
  )));
  const hide = options.redact === true;
  return {
    gameId: game.id,
    exerciseId,
    status: String(game.status || ""),
    date: game.booking?.date ?? null,
    startTime: game.booking?.timeFrom ?? null,
    sourceParticipantsCount: sourceParticipants.length,
    vivaParticipantsCount: vivaPlayers.length,
    lkOnlyParticipants: lkOnly.map((player) => ({
      id: player.id ?? null,
      name: hide ? null : (player.name ?? null),
      phone: null,
      source: player.source ?? null,
    })),
    vivaOnlyParticipants: vivaOnly.map((player) => ({
      id: player.id ?? null,
      name: hide ? null : (player.name ?? null),
    })),
    verdict: lkOnly.length > 0
      ? "phantom_participant"
      : (vivaOnly.length > 0 ? "lk_behind_provider" : "aligned"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let games: PadelGameRecord[] = [];
  if (args.phone) {
    const query = new URLSearchParams({ phone: args.phone });
    if (args.includePast) {
      query.set("includePast", "true");
      query.set("past", "true");
    }
    const gamesPayload = await getJson(`${args.apiOrigin}${DEFAULTS.gamesPath}?${query.toString()}`);
    games = extractGames(gamesPayload).filter((game) => game && game.archived !== true);
    if (args.limit != null) games = games.slice(0, args.limit);
  }
  for (const gameId of args.gameIds) {
    const record = await getJson(
      `${args.apiOrigin}${DEFAULTS.gamesPath}/${encodeURIComponent(gameId)}`,
      { spacingMs: args.spacingMs, retries: 2 },
    );
    if (record && typeof record === "object" && !Array.isArray(record)) {
      games.push(record as PadelGameRecord);
    }
  }

  const perExercise = new Map<string, PadelGamePlayer[]>();
  const findings: DivergenceFinding[] = [];
  const skipped: Array<{ gameId: string; reason: string }> = [];

  for (const game of games) {
    const exerciseId = resolveExerciseId(game);
    if (!exerciseId) {
      skipped.push({ gameId: game.id, reason: "no_exercise_id" });
      continue;
    }
    let vivaPlayers: PadelGamePlayer[];
    try {
      const cached = perExercise.get(exerciseId);
      if (cached) {
        vivaPlayers = cached;
      } else {
        // Strictly sequential: the next provider read starts only after this one
        // resolved, so the rate-limited LK surface is not hammered.
        const payload = await getJson(
          `${args.apiOrigin}${DEFAULTS.participantsPath}?exerciseId=${encodeURIComponent(exerciseId)}&sanitize=false`,
          { spacingMs: args.spacingMs, retries: 4 },
        );
        vivaPlayers = toVivaPlayers(payload, exerciseId);
        perExercise.set(exerciseId, vivaPlayers);
      }
    } catch (error) {
      skipped.push({ gameId: game.id, reason: `provider_read_failed:${(error as Error).message}` });
      continue;
    }
    if (vivaPlayers.length === 0) {
      skipped.push({ gameId: game.id, reason: "provider_roster_empty" });
      continue;
    }
    findings.push(evaluateGame(game, exerciseId, vivaPlayers, { redact: args.redact }));
  }

  const report = {
    apiOrigin: args.apiOrigin,
    phone: args.redact ? null : args.phone,
    gamesScanned: games.length,
    findings: findings.filter((finding) => finding.verdict !== "aligned"),
    aligned: findings.filter((finding) => finding.verdict === "aligned").length,
    skipped,
    mutationsPerformed: false,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(`games scanned: ${report.gamesScanned}`);
  console.log(`aligned: ${report.aligned}`);
  console.log(`divergent: ${report.findings.length}`);
  for (const finding of report.findings) {
    const who = finding.lkOnlyParticipants
      .map((player) => player.name || player.id || "?")
      .join(", ");
    console.log(
      `  ${finding.verdict} ${finding.gameId} ${finding.date ?? "?"} ${finding.startTime ?? "?"} `
      + `lk=${finding.sourceParticipantsCount} viva=${finding.vivaParticipantsCount} lk-only=[${who}]`,
    );
  }
  for (const item of report.skipped) console.log(`  skipped ${item.gameId}: ${item.reason}`);
  console.log("mutations performed: none");
}

export const isCliEntry = (argv1: string | undefined): boolean => {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isCliEntry(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

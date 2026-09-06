import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildVivaGameProjectionSyncCandidate,
  containsForbiddenInlineCredential,
  patchVivaGameProjectionCreateContract,
  publishVivaGameProjectionSyncCandidate,
  VIVA_GAME_PROJECTION_SYNC_IDS,
} from "../prepare_viva_game_projection_sync_candidate.mjs";
import { BASE_GAME_CREATE_FUNC_SHA256 } from "../lib/vivaGameCreateTenantRevisionContract.mjs";

const SOURCE_DIR = path.join(process.cwd(), "scripts/nodered_games_nodes");
const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";
const RUN_STATE_KEY = "lk_viva_game_projection_sync_run_state";
const NOW_ISO = "2026-09-03T10:00:00.000Z";
class FixedDate extends Date {
  constructor(value?: string | number | Date) { super(value === undefined ? NOW_ISO : value); }
  static now() { return Date.parse(NOW_ISO); }
}

function runSource(
  file: string,
  msg: Record<string, unknown>,
  options: { env?: Record<string, unknown>; globals?: Record<string, unknown> } = {},
) {
  const state = new Map(Object.entries(options.globals || {}));
  const envValues = options.env || {};
  const source = fs.readFileSync(path.join(SOURCE_DIR, file), "utf8");
  const result = new Function("msg", "env", "global", "node", "Date", source)(
    msg,
    { get: (key: string) => envValues[key] },
    { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
    { warn() {}, error() {}, status() {} },
    FixedDate,
  );
  return { result, state };
}

const ids = {
  exercise: "11111111-1111-4111-8111-111111111111",
  studio: "22222222-2222-4222-8222-222222222222",
  oldRoom: "33333333-3333-4333-8333-333333333333",
  newRoom: "44444444-4444-4444-8444-444444444444",
};
const context = (mode: "SHADOW" | "ENFORCE" = "ENFORCE") => ({
  source: "scheduler",
  runId: "run-1",
  mode,
  startedAt: NOW_ISO,
  tenantKey: "tenant-test",
  dateFrom: "2026-09-03",
  dateTo: "2026-09-10",
  maxGames: 1000,
  lookaheadDays: 7,
});
const game = (overrides: Record<string, unknown> = {}) => ({
  _id: "mongo-object-id-1",
  id: `viva_${ids.exercise}`,
  tenantKey: "tenant-test",
  revision: 7,
  updatedAt: "2026-09-03T09:00:00.000Z",
  dedupeKey: `viva:${ids.exercise}`,
  status: "PAID",
  booking: {
    vivaExerciseId: ids.exercise,
    exerciseId: ids.exercise,
    studioId: ids.studio,
    roomId: ids.oldRoom,
    roomName: "Court 2",
    date: "2026-09-03",
    timeFrom: "16:30",
    timeTo: "18:30",
  },
  metadata: { vivaExerciseId: ids.exercise },
  participants: [{ id: "opaque-player-1" }],
  resultRosterSnapshot: { version: 3, allPlayers: [{ memberKey: "id:opaque-player-1" }] },
  ...overrides,
});

test("scheduler is disabled by default", () => {
  const { result, state } = runSource("fn_viva_game_projection_sync_token.js", { payload: 1 });
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[2].payload.code, "FEATURE_OFF");
  assert.equal(state.has("lk_viva_game_projection_sync_lease_until"), false);
});

test("scheduler reuses the shared token under a bounded lease", () => {
  const now = Date.parse(NOW_ISO);
  const { result, state } = runSource("fn_viva_game_projection_sync_token.js", {}, {
    env: { VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW" },
    globals: { vivacrm_access_token: "cached-token", vivacrm_token_expires_at: now + 120_000 },
  });
  assert.equal(result[0].vivaToken, "cached-token");
  assert.equal(result[0]._vivaProjectionSync.mode, "SHADOW");
  assert.equal(state.get(LEASE_KEY).runId, result[0]._vivaProjectionSync.runId);
  assert.equal(state.get(LEASE_KEY).until, now + 360_000);
});

test("an overlapping scheduler tick does not replace the active run report", () => {
  const activeReport = { ok: false, code: "RUN_IN_PROGRESS", runId: "active-run" };
  const { result, state } = runSource("fn_viva_game_projection_sync_token.js", {}, {
    env: { VIVA_GAME_PROJECTION_SYNC_MODE: "SHADOW" },
    globals: {
      [LEASE_KEY]: { runId: "active-run", until: Date.parse(NOW_ISO) + 60_000 },
      lk_viva_game_projection_sync_last_report: activeReport,
    },
  });
  assert.equal(result[2].payload.code, "LEASE_ACTIVE");
  assert.deepEqual(state.get("lk_viva_game_projection_sync_last_report"), activeReport);
});

test("token refresh uses env credentials and removes the raw response after storage", () => {
  const prepared = runSource("fn_viva_game_projection_sync_token.js", {}, {
    env: {
      VIVA_GAME_PROJECTION_SYNC_MODE: "ENFORCE",
      VIVA_SERVICE_USERNAME: "service-user",
      VIVA_SERVICE_PASSWORD: "service-password",
    },
  }).result[1];
  assert.match(prepared.payload, /grant_type=password/);
  assert.equal(prepared.requestTimeout, 5_000);
  assert.equal(prepared.followRedirects, false);
  assert.equal(prepared.maxRedirects, 0);
  const owner = prepared._vivaProjectionSyncTokenRefreshOwner;
  const stored = runSource("fn_viva_game_projection_sync_store_token.js", {
    ...prepared,
    statusCode: 200,
    payload: { access_token: "new-token", expires_in: 300 },
  }, { globals: { vivacrm_token_refresh_owner: owner } });
  assert.equal(stored.result[0].vivaToken, "new-token");
  assert.deepEqual(stored.result[0].payload, {});
  assert.equal(stored.result[0].url, undefined);
  assert.equal(stored.state.get("vivacrm_access_token"), "new-token");
});

test("query is tenant-bound and limited to revisioned future Viva projections", () => {
  const { result } = runSource("fn_viva_game_projection_sync_query.js", {
    _vivaProjectionSync: context(),
    vivaToken: "token",
  }, {
    env: {
      PADLHUB_PLATFORM_TENANT_KEY: "tenant-test",
      VIVA_GAME_PROJECTION_SYNC_LOOKAHEAD_DAYS: "7",
    },
  });
  const query = result[0].payload;
  assert.equal(query.tenantKey, "tenant-test");
  assert.deepEqual(query.revision, { $type: "number" });
  assert.deepEqual(query["booking.date"], { $gte: "2026-09-03", $lte: "2026-09-10" });
  assert.deepEqual(query["booking.vivaExerciseId"], { $type: "string", $ne: "" });

  const defaulted = runSource("fn_viva_game_projection_sync_query.js", {
    _vivaProjectionSync: context(),
    vivaToken: "token",
  }, { env: { PADLHUB_PLATFORM_TENANT_KEY: "tenant-test" } }).result[0];
  assert.equal(defaulted._vivaProjectionSync.lookaheadDays, 7);
  assert.deepEqual(defaulted.payload["booking.date"], { $gte: "2026-09-03", $lte: "2026-09-10" });
});

test("games are grouped into one provider read per date and ambiguous IDs are excluded", () => {
  const lease = { runId: "run-1", until: Date.parse(NOW_ISO) + 360_000 };
  const { result, state } = runSource("fn_viva_game_projection_sync_group.js", {
    _vivaProjectionSync: context(),
    vivaToken: "secret-token",
    payload: [game()],
  }, { globals: { [LEASE_KEY]: lease } });
  assert.equal(result[0].length, 1);
  assert.match(result[0][0].url, /date=2026-09-03/);
  assert.match(result[0][0].url, /page=0&size=1000/);
  assert.equal(result[0][0]._vivaProjectionSyncGroup.pageSize, 1000);
  assert.equal(result[0][0]._vivaProjectionSyncGroup.maxPages, 1);
  assert.equal(result[0][0].headers.Authorization, "Bearer secret-token");
  assert.equal(result[0][0].requestTimeout, 8_000);
  assert.equal(result[0][0].followRedirects, false);
  assert.equal(result[0][0].maxRedirects, 0);
  assert.equal(JSON.stringify(result[1].payload).includes("secret-token"), false);
  assert.equal(state.get(RUN_STATE_KEY).pendingDates, 1);
  assert.equal(state.get(RUN_STATE_KEY).pendingWrites, 0);

  const ambiguous = game({ metadata: { vivaExerciseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
  const rejected = runSource("fn_viva_game_projection_sync_group.js", {
    _vivaProjectionSync: context(),
    vivaToken: "token",
    payload: [ambiguous],
  }, { globals: { [LEASE_KEY]: lease } }).result;
  assert.equal(rejected[0], null);
  assert.equal(rejected[1].payload.skipped.exerciseIdentityAmbiguous, 1);

  const crossTenant = game({ tenantKey: "other-tenant" });
  const isolated = runSource("fn_viva_game_projection_sync_group.js", {
    _vivaProjectionSync: context(),
    vivaToken: "token",
    payload: [crossTenant],
  }, { globals: { [LEASE_KEY]: lease } }).result;
  assert.equal(isolated[0], null);
  assert.equal(isolated[1].payload.skipped.tenantMismatch, 1);
});

const providerRow = (overrides: Record<string, unknown> = {}) => ({
  id: ids.exercise,
  studio: { id: ids.studio },
  room: { id: ids.newRoom, name: "Court 9" },
  date: "2026-09-03",
  timeFrom: "2026-09-03T16:30:00+03:00",
  timeTo: "2026-09-03T18:30:00+03:00",
  status: "ACTIVE",
  ...overrides,
});

function resolve(mode: "SHADOW" | "ENFORCE", payload: unknown) {
  return runResolver(mode, payload).result;
}

function projectionRunState(mode: "SHADOW" | "ENFORCE" = "ENFORCE", pendingDates = 1) {
  return {
    version: 1,
    runId: "run-1",
    mode,
    startedAt: NOW_ISO,
    checkedCount: 1,
    eligibleCount: 1,
    dateCount: pendingDates,
    pendingDates,
    completedDates: 0,
    pendingWrites: 0,
    writeScheduled: 0,
    writeSucceeded: 0,
    writeFailed: 0,
    driftCount: 0,
    failed: false,
    failures: [],
    skipped: {},
    updatedAt: NOW_ISO,
  };
}

function runResolver(mode: "SHADOW" | "ENFORCE", payload: unknown) {
  const source = game();
  return runSource("fn_viva_game_projection_sync_resolve.js", {
    _vivaProjectionSync: context(mode),
    _vivaProjectionSyncGroup: {
      date: "2026-09-03",
      page: 0,
      pageSize: 1000,
      maxPages: 1,
      providerRows: [],
      lastFingerprint: null,
      games: [{
        _id: source._id,
        id: source.id,
        tenantKey: source.tenantKey,
        revision: source.revision,
        status: source.status,
        updatedAt: source.updatedAt,
        exerciseId: source.booking.vivaExerciseId,
        studioId: source.booking.studioId,
        roomId: source.booking.roomId,
        roomName: source.booking.roomName,
        date: source.booking.date,
        timeFrom: source.booking.timeFrom,
        timeTo: source.booking.timeTo,
      }],
    },
    statusCode: 200,
    headers: { Authorization: "Bearer secret-token" },
    _vivaProjectionSyncBearer: "secret-token",
    vivaToken: "secret-token",
    payload,
  }, {
    globals: {
      [RUN_STATE_KEY]: projectionRunState(mode),
      [LEASE_KEY]: { runId: "run-1", until: Date.parse(NOW_ISO) + 360_000 },
    },
  });
}

test("exact drift builds one revision CAS containing no roster, payment or result fields", () => {
  const result = resolve("ENFORCE", { content: [providerRow()], last: true, totalPages: 1 });
  assert.equal(result[0].length, 1);
  const write = result[0][0];
  assert.deepEqual(Object.keys(write).sort(), [
    "_vivaProjectionSync",
    "_vivaProjectionSyncWriteAck",
    "payload",
  ]);
  assert.equal(write.query, undefined);
  assert.equal(write.payload.length, 3);
  const [filter, update, options] = write.payload;
  assert.equal(filter.revision, 7);
  assert.equal(filter.status, "PAID");
  assert.equal(filter["booking.vivaExerciseId"], ids.exercise);
  assert.equal(filter["booking.roomId"], ids.oldRoom);
  assert.equal(filter["booking.date"], "2026-09-03");
  assert.equal(filter["booking.timeFrom"], "16:30");
  assert.equal(filter["booking.timeTo"], "18:30");
  assert.deepEqual(options, { upsert: false });
  assert.deepEqual(Object.keys(update.$set).sort(), [
    "audit.lastEvent",
    "audit.updatedAt",
    "audit.version",
    "booking.roomId",
    "booking.roomName",
    "updatedAt",
  ]);
  assert.deepEqual(update.$inc, { revision: 1 });
  assert.equal(update.$set["booking.roomId"], ids.newRoom);
  assert.equal(update.$set["booking.roomName"], "Court 9");
  assert.equal(JSON.stringify(write).includes("participants"), false);
  assert.equal(JSON.stringify(write).includes("payment"), false);
  assert.equal(JSON.stringify(write).includes("resultRosterSnapshot"), false);
  assert.equal(JSON.stringify(write).includes("secret-token"), false);
});

test("shadow mode reports drift without a Mongo write", () => {
  const result = resolve("SHADOW", { content: [providerRow()], last: true, totalPages: 1 });
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[2].payload.code, "SHADOW_DATE_RESOLVED");
  assert.equal(result[2].payload.driftCount, 1);
  assert.equal(result[2].payload.writeCount, 0);
});

test("bounded unpaged Admin array matching the observed response is treated as complete", () => {
  const payload = [
    providerRow(),
    ...Array.from({ length: 356 }, (_unused, index) => providerRow({ id: `unrelated-${index}` })),
  ];
  const result = resolve("ENFORCE", payload);
  assert.equal(result[0].length, 1);
  assert.equal(result[1], null);
  assert.equal(result[2].payload.code, "PROVIDER_DATE_RESOLVED");
  assert.equal(result[2].payload.providerRowCount, 357);
});

test("unpaged Admin array at the 1,000-row completeness bound fails closed", () => {
  const result = resolve("ENFORCE", Array.from({ length: 1000 }, () => providerRow()));
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[2].payload.code, "PROVIDER_PAGE_TRUNCATED");
  assert.equal(result[2].payload.providerRowCount, 1000);
});

test("same room, wrong studio, cancellation and incomplete provider page all fail closed", () => {
  const same = resolve("ENFORCE", {
    content: [providerRow({ room: { id: ids.oldRoom, name: "Court 2" } })],
    last: true,
  });
  assert.equal(same[0], null);
  assert.equal(same[2].payload.skipped.unchanged, 1);

  const wrongStudio = resolve("ENFORCE", {
    content: [providerRow({ studio: { id: "55555555-5555-4555-8555-555555555555" } })],
    last: true,
  });
  assert.equal(wrongStudio[0], null);
  assert.equal(wrongStudio[2].payload.skipped.studioMismatch, 1);

  const cancelled = resolve("ENFORCE", {
    content: [providerRow({ status: "CANCELLED" })],
    last: true,
  });
  assert.equal(cancelled[0], null);
  assert.equal(cancelled[2].payload.skipped.cancelled, 1);

  const incomplete = resolve("ENFORCE", {
    content: [providerRow()],
    last: false,
    totalPages: 2,
  });
  assert.equal(incomplete[0], null);
  assert.equal(incomplete[1], null);
  assert.equal(incomplete[2].payload.code, "PROVIDER_PAGE_TRUNCATED");
});

test("provider pagination stops on a repeated page without emitting a write", () => {
  const source = game();
  const repeated = runSource("fn_viva_game_projection_sync_resolve.js", {
    _vivaProjectionSync: context("ENFORCE"),
    _vivaProjectionSyncGroup: {
      date: "2026-09-03",
      page: 1,
      pageSize: 200,
      maxPages: 5,
      providerRows: [],
      lastFingerprint: ids.exercise,
      games: [{
        _id: source._id,
        id: source.id,
        tenantKey: source.tenantKey,
        revision: source.revision,
        status: source.status,
        exerciseId: source.booking.vivaExerciseId,
        studioId: source.booking.studioId,
        roomId: source.booking.roomId,
        roomName: source.booking.roomName,
        date: source.booking.date,
        timeFrom: source.booking.timeFrom,
        timeTo: source.booking.timeTo,
      }],
    },
    _vivaProjectionSyncBearer: "secret-token",
    statusCode: 200,
    payload: { content: [providerRow()], last: false },
  }, { globals: { [RUN_STATE_KEY]: projectionRunState("ENFORCE") } }).result;
  assert.equal(repeated[0], null);
  assert.equal(repeated[1], null);
  assert.equal(repeated[2].payload.code, "PROVIDER_PAGE_REPEATED");
  assert.equal(JSON.stringify(repeated[2]).includes("secret-token"), false);
});

test("unrecognized or contradictory provider pagination fails closed", () => {
  const malformed = resolve("ENFORCE", { unexpected: [providerRow()] });
  assert.equal(malformed[0], null);
  assert.equal(malformed[2].payload.code, "PROVIDER_RESPONSE_SCHEMA_INVALID");

  const missingMetadata = resolve("ENFORCE", { content: [providerRow()] });
  assert.equal(missingMetadata[0], null);
  assert.equal(missingMetadata[2].payload.code, "PROVIDER_PAGE_METADATA_INVALID");

  const contradictory = resolve("ENFORCE", {
    content: [providerRow()],
    last: false,
    totalPages: 1,
  });
  assert.equal(contradictory[0], null);
  assert.equal(contradictory[2].payload.code, "PROVIDER_PAGE_METADATA_CONFLICT");
});

test("write acknowledgement distinguishes success from a revision race", () => {
  const ack = {
    runId: "run-1",
    gameId: "game-1",
    exerciseId: ids.exercise,
    expectedRevision: 7,
    expectedNextRevision: 8,
    previousRoomId: ids.oldRoom,
    roomId: ids.newRoom,
  };
  const success = runSource("fn_viva_game_projection_sync_write_ack.js", {
    _vivaProjectionSyncWriteAck: ack,
    payload: [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }],
  }).result;
  assert.equal(success.payload.code, "ROOM_RECONCILED");
  assert.equal(success.payload.ok, true);

  const race = runSource("fn_viva_game_projection_sync_write_ack.js", {
    _vivaProjectionSyncWriteAck: ack,
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
  }).result;
  assert.equal(race.payload.code, "CAS_CONFLICT");

  const unacknowledged = runSource("fn_viva_game_projection_sync_write_ack.js", {
    _vivaProjectionSyncWriteAck: ack,
    payload: { acknowledged: false, matchedCount: 1, modifiedCount: 1 },
  }).result;
  assert.equal(unacknowledged.payload.ok, false);
  assert.equal(unacknowledged.payload.code, "WRITE_NOT_ACKNOWLEDGED");

  const stringCounts = runSource("fn_viva_game_projection_sync_write_ack.js", {
    _vivaProjectionSyncWriteAck: ack,
    payload: { acknowledged: true, matchedCount: "1", modifiedCount: "1" },
  }).result;
  assert.equal(stringCounts.payload.ok, false);
  assert.equal(stringCounts.payload.code, "WRITE_NOT_ACKNOWLEDGED");
});

test("run finalizer owns the lease, waits for write ACKs, and publishes one aggregate report", () => {
  const resolved = runResolver("ENFORCE", { content: [providerRow()], last: true, totalPages: 1 });
  const completion = resolved.result[2];
  assert.equal(resolved.state.get(RUN_STATE_KEY).pendingWrites, 1);
  const afterDate = runSource("fn_viva_game_projection_sync_finalize.js", completion, {
    globals: Object.fromEntries(resolved.state),
  });
  assert.equal(afterDate.result.payload.code, "RUN_PROGRESS");
  assert.equal(afterDate.state.get(RUN_STATE_KEY).pendingDates, 0);
  assert.equal(afterDate.state.get(RUN_STATE_KEY).pendingWrites, 1);

  const ack = runSource("fn_viva_game_projection_sync_write_ack.js", {
    _vivaProjectionSync: { runId: "run-1", mode: "ENFORCE" },
    _vivaProjectionSyncWriteAck: {
      runId: "run-1",
      date: "2026-09-03",
      gameId: "game-1",
      exerciseId: ids.exercise,
      expectedRevision: 7,
      expectedNextRevision: 8,
      previousRoomId: ids.oldRoom,
      roomId: ids.newRoom,
    },
    payload: [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }],
  }).result;
  const finalized = runSource("fn_viva_game_projection_sync_finalize.js", ack, {
    globals: Object.fromEntries(afterDate.state),
  });
  assert.equal(finalized.result.payload.code, "RUN_COMPLETED");
  assert.equal(finalized.result.payload.writeSucceeded, 1);
  assert.equal(finalized.state.get(LEASE_KEY), null);
  assert.deepEqual(finalized.state.get("lk_viva_game_projection_sync_last_report"), finalized.result.payload);
});

test("run finalizer latches a date failure so a later success cannot hide it", () => {
  const initial = projectionRunState("SHADOW", 2);
  const globals = {
    [RUN_STATE_KEY]: initial,
    [LEASE_KEY]: { runId: "run-1", until: Date.parse(NOW_ISO) + 360_000 },
  };
  const failed = runSource("fn_viva_game_projection_sync_finalize.js", {
    _vivaProjectionSync: { runId: "run-1", mode: "SHADOW" },
    _vivaProjectionSyncEvent: {
      kind: "DATE_DONE",
      ok: false,
      code: "PROVIDER_READ_FAILED",
      runId: "run-1",
      date: "2026-09-03",
    },
  }, { globals });
  assert.equal(failed.result.payload.failed, true);

  const completed = runSource("fn_viva_game_projection_sync_finalize.js", {
    _vivaProjectionSync: { runId: "run-1", mode: "SHADOW" },
    _vivaProjectionSyncEvent: {
      kind: "DATE_DONE",
      ok: true,
      code: "SHADOW_DATE_RESOLVED",
      runId: "run-1",
      date: "2026-09-04",
      checkedCount: 1,
      driftCount: 0,
      skipped: { unchanged: 1 },
    },
  }, { globals: Object.fromEntries(failed.state) });
  assert.equal(completed.result.payload.code, "RUN_COMPLETED_WITH_ERRORS");
  assert.equal(completed.result.payload.ok, false);
  assert.equal(completed.result.payload.failures[0].code, "PROVIDER_READ_FAILED");
});

test("fan-out errors keep the owned lease until the aggregate finalizer records failure", () => {
  const lease = { runId: "run-1", until: Date.parse(NOW_ISO) + 360_000 };
  const caught = runSource("fn_viva_game_projection_sync_error.js", {
    _vivaProjectionSync: context("SHADOW"),
    _vivaProjectionSyncGroup: { date: "2026-09-03", games: [game()] },
    _vivaProjectionSyncBearer: "secret-token",
    headers: { Authorization: "Bearer secret-token" },
    error: { source: { id: "provider-http" }, message: "sensitive upstream body" },
  }, {
    globals: {
      [RUN_STATE_KEY]: projectionRunState("SHADOW"),
      [LEASE_KEY]: lease,
    },
  });
  assert.deepEqual(caught.state.get(LEASE_KEY), lease);
  assert.equal(caught.result._vivaProjectionSyncEvent.kind, "DATE_DONE");
  assert.equal(JSON.stringify(caught.result).includes("secret-token"), false);
  assert.equal(JSON.stringify(caught.result).includes("sensitive upstream body"), false);

  const finalized = runSource("fn_viva_game_projection_sync_finalize.js", caught.result, {
    globals: Object.fromEntries(caught.state),
  });
  assert.equal(finalized.result.payload.code, "RUN_COMPLETED_WITH_ERRORS");
  assert.equal(finalized.state.get(LEASE_KEY), null);
});

const liveCreateSource = fs.readFileSync(
  path.join(process.cwd(), "scripts/tests/fixtures/viva_game_projection_sync/live_create_08c2.txt"),
  "utf8",
);

function syntheticFlow() {
  return [
    { id: "4b91e2a2413688db", type: "tab", label: "LK Games", disabled: false },
    { id: "mongo-client", type: "mongodb4-client", name: "mongo" },
    {
      id: "8b64bb43086a39e1",
      type: "mongodb4",
      z: "4b91e2a2413688db",
      name: "Find lk game by id",
      clientNode: "mongo-client",
      mode: "collection",
      collection: "lk_games",
      operation: "find",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
      wires: [["terminal"]],
    },
    { id: "route", type: "http in", z: "4b91e2a2413688db", method: "get", url: "/existing", wires: [["terminal"]] },
    {
      id: "e656cff36a8cd210",
      type: "function",
      z: "4b91e2a2413688db",
      name: "Prepare game upsert",
      func: liveCreateSource,
      outputs: 4,
      wires: [["terminal"], ["terminal"], ["terminal"], ["terminal"]],
    },
    { id: "terminal", type: "debug", z: "4b91e2a2413688db", wires: [] },
  ];
}

function runPatchedCreate(payload: Record<string, unknown>, platformTenantKey?: string) {
  const patched = patchVivaGameProjectionCreateContract(liveCreateSource);
  return new Function("msg", "env", patched)(
    { req: { path: "/lk/games", query: {} }, payload },
    { get: (key: string) => key === "PADLHUB_PLATFORM_TENANT_KEY" ? platformTenantKey : undefined },
  ) as unknown[];
}

function runCurrentCreate(payload: Record<string, unknown>, platformTenantKey?: string) {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/nodered_games_nodes/fn_create.js"), "utf8");
  return new Function("msg", "env", source)(
    { req: { path: "/lk/games", query: {} }, payload },
    { get: (key: string) => key === "PADLHUB_PLATFORM_TENANT_KEY" ? platformTenantKey : undefined },
  ) as unknown[];
}

const minimalCreatePayload = (tenantKey: unknown = null) => ({
  tenantKey,
  organizer: { id: "organizer-1", name: "Organizer", phone: "79850000000" },
  booking: {
    studioId: "studio-1",
    studioName: "Studio",
    roomId: "room-1",
    roomName: "Court",
    date: "2026-09-05",
    timeFrom: "12:00",
    timeTo: "14:00",
    vivaExerciseId: "11111111-1111-4111-8111-111111111111",
  },
  payment: { paid: true },
  participants: [],
});

test("game create patch uses only the server tenant and starts a numeric revision", () => {
  const patched = patchVivaGameProjectionCreateContract(liveCreateSource);
  assert.equal(crypto.createHash("sha256").update(patched).digest("hex"), BASE_GAME_CREATE_FUNC_SHA256);
  assert.equal(patchVivaGameProjectionCreateContract(patched), patched);
  const output = runPatchedCreate(minimalCreatePayload(), "iSkq6G");
  const write = output[0] as Record<string, any>;
  assert.equal(write.payload.$set.tenantKey, "iSkq6G");
  assert.equal(write.query.tenantKey, "iSkq6G");
  assert.deepEqual(write.payload.$inc, { revision: 1 });
  assert.equal(write.payload.$set.payment.paid, true);
});

test("game create patch fails closed on missing or conflicting tenant configuration", () => {
  const missing = runPatchedCreate(minimalCreatePayload(), undefined);
  assert.equal((missing[1] as any).statusCode, 503);
  assert.equal((missing[1] as any).payload.code, "GAME_TENANT_CONFIG_INVALID");
  const mismatch = runPatchedCreate(minimalCreatePayload("other-tenant"), "iSkq6G");
  assert.equal((mismatch[1] as any).statusCode, 403);
  assert.equal((mismatch[1] as any).payload.code, "GAME_TENANT_MISMATCH");
  assert.equal(mismatch[0], null);
});

test("tracked game create source follows the same server-owned tenant contract", () => {
  const accepted = runCurrentCreate(minimalCreatePayload(), "iSkq6G");
  assert.equal((accepted[0] as any).payload.$set.tenantKey, "iSkq6G");
  assert.deepEqual((accepted[0] as any).payload.$inc, { revision: 1 });
  assert.equal((accepted[0] as any)._recordForResponse.revision, 1);
  const rejected = runCurrentCreate(minimalCreatePayload("other-tenant"), "iSkq6G");
  assert.equal((rejected[1] as any).payload.code, "GAME_TENANT_MISMATCH");
});

test("candidate adds an isolated graph and preserves existing nodes and routes", () => {
  const flow = syntheticFlow();
  const before = structuredClone(flow);
  const sourceSha = crypto.createHash("sha256").update(JSON.stringify(flow)).digest("hex");
  const built = buildVivaGameProjectionSyncCandidate(flow, sourceSha);
  const changedExisting = built.candidate.slice(0, before.length)
    .filter((node, index) => JSON.stringify(node) !== JSON.stringify(before[index]));
  assert.deepEqual(changedExisting.map((node) => node.id), ["e656cff36a8cd210"]);
  const beforeCreate = before.find((node) => node.id === "e656cff36a8cd210");
  const afterCreate = built.candidate.find((node) => node.id === "e656cff36a8cd210");
  assert.deepEqual({ ...afterCreate, func: beforeCreate?.func }, beforeCreate);
  assert.equal(built.candidate.filter((node) => node.type === "http in").length, 1);
  assert.equal(built.report.changedNodes.length, 1);
  assert.deepEqual(built.report.changedNodes[0].changedFields, ["func"]);
  assert.equal(built.report.addedNodes.length, Object.keys(VIVA_GAME_PROJECTION_SYNC_IDS).length);
  assert.equal(built.report.invariants.defaultMode, "OFF");
  const update = built.candidate.find((node) => node.id === VIVA_GAME_PROJECTION_SYNC_IDS.update);
  assert.equal(update?.operation, "updateOne");
  assert.equal(update?.clientNode, "mongo-client");
  const resolver = built.candidate.find((node) => node.id === VIVA_GAME_PROJECTION_SYNC_IDS.resolve);
  assert.equal(resolver?.outputs, 3);
  assert.deepEqual(resolver?.wires?.[1], [VIVA_GAME_PROJECTION_SYNC_IDS.delay]);
  assert.deepEqual(resolver?.wires?.[2], [VIVA_GAME_PROJECTION_SYNC_IDS.finalize]);
  const ack = built.candidate.find((node) => node.id === VIVA_GAME_PROJECTION_SYNC_IDS.ack);
  const error = built.candidate.find((node) => node.id === VIVA_GAME_PROJECTION_SYNC_IDS.error);
  assert.deepEqual(ack?.wires?.[0], [VIVA_GAME_PROJECTION_SYNC_IDS.finalize]);
  assert.deepEqual(error?.wires?.[0], [VIVA_GAME_PROJECTION_SYNC_IDS.finalize]);
});

test("candidate credential guard rejects private keys and credentialed Mongo URIs", () => {
  const privateKeyMarker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
  const credentialedMongoUri = ["mongodb://user:password", "mongo.example/lk"].join("@");
  assert.equal(containsForbiddenInlineCredential(`${privateKeyMarker}\nopaque`), true);
  assert.equal(containsForbiddenInlineCredential(credentialedMongoUri), true);
  assert.equal(containsForbiddenInlineCredential("const mode = 'default_inline';"), true);
  assert.equal(containsForbiddenInlineCredential("const mode = env.get('MODE');"), false);
});

test("publisher accepts only a verified fresh live workspace and writes private artifacts", () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viva-projection-sync-")));
  try {
    fs.chmodSync(workspace, 0o700);
    const input = path.join(workspace, "input");
    fs.mkdirSync(input, { mode: 0o700 });
    const sourcePath = path.join(input, "source.flow.json");
    const sourceBytes = Buffer.from(`${JSON.stringify(syntheticFlow(), null, 2)}\n`);
    fs.writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
    fs.chmodSync(sourcePath, 0o600);
    const sourceSha256 = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    const metaPath = path.join(input, "source.flow.meta.json");
    fs.writeFileSync(metaPath, `${JSON.stringify({
      formatVersion: 1,
      sourceKind: "live-147",
      sourceHost: "lk-primary-147",
      sourceUser: "root",
      sourcePort: "22",
      remoteFlowPath: "/root/.node-red/flows.json",
      localSourcePath: sourcePath,
      pulledAt: new Date().toISOString(),
      sourceSha256,
      nodeCount: syntheticFlow().length,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(metaPath, 0o600);

    const outputDirectory = path.join(workspace, "candidate");
    const report = publishVivaGameProjectionSyncCandidate({ workspace, outputDirectory });
    assert.equal(report.sourceSha256, sourceSha256);
    assert.equal(report.invariants.deploymentPerformed, false);
    assert.equal(fs.statSync(outputDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(outputDirectory, "candidate.flow.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(outputDirectory, "report.json")).mode & 0o777, 0o600);

    const repoAlias = path.join(workspace, "repo-alias");
    fs.symlinkSync(process.cwd(), repoAlias, "dir");
    const forbiddenName = `.viva-projection-sync-forbidden-${process.pid}`;
    assert.throws(
      () => publishVivaGameProjectionSyncCandidate({
        workspace,
        outputDirectory: path.join(repoAlias, forbiddenName),
      }),
      /Output parent must be a real directory/,
    );
    assert.equal(fs.existsSync(path.join(process.cwd(), forbiddenName)), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("candidate rejects disabled tab, Mongo anchor drift and node ID collision", () => {
  const sourceSha = "a".repeat(64);
  const disabled = syntheticFlow();
  disabled[0].disabled = true;
  assert.throws(() => buildVivaGameProjectionSyncCandidate(disabled, sourceSha), /tab is disabled/);

  const drift = syntheticFlow();
  drift[2].collection = "other";
  assert.throws(() => buildVivaGameProjectionSyncCandidate(drift, sourceSha), /Mongo anchor contract mismatch/);

  const createDrift = syntheticFlow();
  const create = createDrift.find((node) => node.id === "e656cff36a8cd210");
  if (create) create.func = `${String(create.func)}\n// drift`;
  assert.throws(() => buildVivaGameProjectionSyncCandidate(createDrift, sourceSha), /Game create function preimage mismatch/);

  const collision = syntheticFlow();
  collision.push({ id: VIVA_GAME_PROJECTION_SYNC_IDS.inject, type: "debug" });
  assert.throws(() => buildVivaGameProjectionSyncCandidate(collision, sourceSha), /already exists/);
});

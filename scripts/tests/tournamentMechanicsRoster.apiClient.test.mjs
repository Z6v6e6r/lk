import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isStableTournamentClientId } from "../../src/utils/tournamentRosterSearch.ts";

const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
const start = source.indexOf("async function requestTournamentMechanicsRoster(");
const end = source.indexOf("\nexport async function ", source.indexOf("export async function apiRefreshTournamentMechanicsRoster(", start) + 1);
const { outputText } = ts.transpileModule(source.slice(start, end).replaceAll("export async ", "async "), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});
const createApi = new Function(
  "request", "isRecord", "isStableTournamentClientId", "buildTournamentApiRequestOptions", "phabHeaders",
  "apiFetchTournamentParticipants", "apiRefreshTournamentParticipants",
  `${outputText}; return { apiFetchTournamentMechanicsRoster, apiRefreshTournamentMechanicsRoster };`,
);
const exerciseId = "10000000-0000-4000-8000-000000000001";
const firstClient = "10000000-0000-4000-8000-000000000002";
const secondClient = "10000000-0000-4000-8000-000000000003";
const paidBooking = "20000000-0000-4000-8000-000000000001";
const fetchedAt = "2026-01-01T00:00:00.000Z";

function fixture(result) {
  const legacy = [];
  const calls = [];
  const api = createApi(
    async (path, options) => {
      calls.push({ path, options });
      return result();
    },
    value => Boolean(value && typeof value === "object" && !Array.isArray(value)),
    isStableTournamentClientId,
    options => options,
    () => ({ "X-PadlHub-Tenant-Key": "fixture" }),
    async () => { legacy.push("get"); return { data: [], error: null, status: 200 }; },
    async () => { legacy.push("post"); return { data: null, error: null, status: 200 }; },
  );
  return { ...api, calls, legacy };
}

test("GET and POST use the same authenticated CUP exercise roster and separate client and booking IDs", async () => {
  const participants = [
    { id: firstClient, name: "Участник №1", confirmationPending: true },
    { id: secondClient, name: "Synthetic", vivaBookingId: paidBooking, paymentStatus: "PAID" },
  ];
  const api = fixture(() => ({ status: 200, error: null, data: { exerciseId, fetchedAt, participants } }));
  const signal = new AbortController().signal;
  const read = await api.apiFetchTournamentMechanicsRoster(exerciseId, { signal });
  const refreshed = await api.apiRefreshTournamentMechanicsRoster(exerciseId, signal);
  assert.deepEqual(read.data, refreshed.data.participants);
  assert.deepEqual(read.data.map(row => [row.client.id, row.id, row.mechanicsRosterOnly, row.confirmationPending]), [
    [firstClient, firstClient, true, true], [secondClient, paidBooking, false, false],
  ]);
  assert.deepEqual(api.calls.map(call => call.options.method), ["GET", "POST"]);
  for (const call of api.calls) {
    assert.equal(call.path, `/tournaments/${exerciseId}/mechanics-roster`);
    assert.equal(call.options.auth, true);
    assert.equal(call.options.allowFallback, false);
    assert.equal(call.options.retries, 0);
    assert.equal(call.options.signal, signal);
  }
  assert.deepEqual(api.legacy, []);
});

test("only an explicit unlinked exercise uses legacy reads and refresh", async () => {
  let refusal = { status: 403, code: "TOURNAMENT_ROSTER_FORBIDDEN" };
  const api = fixture(() => ({ status: refusal.status, error: { raw: { code: refusal.code } } }));
  assert.equal((await api.apiFetchTournamentMechanicsRoster(exerciseId, {})).status, 403);
  assert.equal((await api.apiRefreshTournamentMechanicsRoster(exerciseId)).status, 403);
  assert.deepEqual(api.legacy, []);
  refusal = { status: 404, code: "TOURNAMENT_ROSTER_UNLINKED" };
  await api.apiFetchTournamentMechanicsRoster(exerciseId, {});
  await api.apiRefreshTournamentMechanicsRoster(exerciseId);
  assert.deepEqual(api.legacy, ["get", "post"]);
});

test("wrong exercise and operation IDs are rejected without applying a partial roster", async () => {
  let data = { exerciseId: secondClient, fetchedAt, participants: [] };
  const api = fixture(() => ({ status: 200, error: null, data }));
  assert.equal((await api.apiRefreshTournamentMechanicsRoster(exerciseId)).data, null);
  data = { exerciseId, fetchedAt, participants: [{ id: "owner:operation", name: "Synthetic" }] };
  assert.equal((await api.apiFetchTournamentMechanicsRoster(exerciseId, {})).data, null);
  assert.deepEqual(api.legacy, []);
});

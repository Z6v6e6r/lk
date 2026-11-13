import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { UUID } from "../../src/utils/errorDiagnosticsCore.mjs";
import { gamePatchDiagnosticUrl } from "../../src/utils/gamePatchDiagnostics.mjs";

const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const apiSource = parse("src/utils/apiClient.ts");
const pages = [parse("src/components/games/GamesPage.tsx"), parse("src/components/games/GameJoinPage.tsx")];
const functions = ["request", "executeRequestWithResolvedBaseUrls", "resolveRequestBaseUrlCandidates", "dedupeBaseUrls", "isServ2LkReadRequest", "getRequestMethod", "rawRequest", "withRetry", "writePadelGameRecord", "apiUpdatePadelGameRecord", "hydratePadelGameRecordAfterWrite", "apiFetchPadelGameRecord"];
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const actualApi = compile(functions.map((name) => {
  const fn = apiSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, name);
  return fn.getText(apiSource).replace(/^export\s+/, "");
}).join("\n") + "\nglobalThis.update = apiUpdatePadelGameRecord;");
const clone = (value) => JSON.parse(JSON.stringify(value));
const stale = { id: "fixture-game", updatedAt: "version-old", participants: [{ id: "old-player" }], waitlist: [], metadata: { obsolete: true } };
const fresh = { id: "fixture-game", updatedAt: "version-new", participants: [], waitlist: [], metadata: { canonical: true } };
const conflict = { code: "GAME_PATCH_VERSION_CONFLICT", error: "Игра уже изменилась. Обновите данные" };
const payload = () => ({ expectedUpdatedAt: stale.updatedAt, participants: [{ id: "intended-player" }], waitlist: [] });

// Run actual request/retry/write/read/hydrate code; only transport, normalization,
// auth, cache and diagnostics boundaries are fixtures. No real network is available.
function client({ patchStatus = 409, readStatus = 200, readBody = fresh, throwRead = false, throwPatch = false, diagnosticUnavailable = false } = {}) {
  const calls = [], delays = [], diagnostics = [];
  const context = vm.createContext({
    Headers, Response, FormData, URL, performance,
    API_BASE: "https://fixture.invalid", SERV2: "https://fixture.invalid", SERV2_FALLBACK: "https://fixture.invalid",
    getServ2Origin: () => "https://fixture.invalid", resolveLkApiBaseUrlCandidates: () => ["https://fixture.invalid"],
    readAuthToken: () => "fixture-session", requestChangesSubscriptions: () => false, invalidateSubscriptionSnapshot: () => {},
    isLkIdleRequestPausedError: () => false, resolveRequestCacheConfig: () => null,
    diagnosticId: () => { if (diagnosticUnavailable) throw Error("fixture crypto unavailable"); return randomUUID(); },
    callerBuild: () => "b".repeat(40), gamePatchDiagnosticUrl, abortCause: () => null, UUID,
    captureSplitLeaveInitiator: () => {},
    trackClientError: (_source, _error, context) => diagnostics.push(context), isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    pickString: (record, keys) => keys.map((key) => record[key]).find((value) => typeof value === "string" && value) ?? null,
    isGameExerciseIdMissingGuard: () => false, normalizePadelGameRecord: (value) => value?.id ? value : null,
    mergePadelGameRecord: (before, after) => ({ ...before, ...after }),
    requestWithBaseUrlFallback: () => { throw new Error("Fixture must not use additional origins"); },
    setTimeout: (fn, delay) => { delays.push(delay); fn(); },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const patch = options.method === "PATCH";
      if (patch ? throwPatch : throwRead) throw new Error("fixture transport failure");
      const status = patch ? patchStatus : readStatus;
      const body = patch ? (patchStatus === 200 ? { id: fresh.id, updatedAt: fresh.updatedAt } : conflict) : readBody;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  vm.runInContext('"use strict";\n' + actualApi, context);
  return { update: context.update, request: vm.runInContext("request", context), calls, delays, diagnostics };
}

function matches(source, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
function runnable(expression, source, scope) {
  return new Function(...Object.keys(scope), compile(`return (${expression.getText(source)});`))(...Object.values(scope));
}
function callback(name, scope) {
  const declaration = matches(pages[0], (node) => ts.isVariableDeclaration(node) && node.name.getText(pages[0]) === name)[0];
  assert.ok(declaration, name);
  return runnable(declaration.initializer.arguments[0], pages[0], scope);
}
function background(source, scope) {
  const then = matches(source, (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "then" && node.arguments[0]?.parameters?.[0]?.name.getText(source) === "patchResult"
    && node.arguments[0].getText(source).includes("patchResult.conflictRecord"))[0];
  assert.ok(then, "actual roster sync continuation");
  return runnable(then.arguments[0], source, scope);
}

for (const expectedUpdatedAt of ["version-old", null]) {
  test(`409 sends one PATCH preserving expectedUpdatedAt=${expectedUpdatedAt}, reads fresh state and remains an error`, async () => {
    const api = client();
    const intended = { ...payload(), expectedUpdatedAt };
    const result = await api.update(" fixture-game ", intended);
    assert.deepEqual(api.calls.map(({ options }) => options.method), ["PATCH", "GET"]);
    assert.deepEqual(JSON.parse(api.calls[0].options.body), intended);
    assert.equal(api.calls[0].options.headers.get("Authorization"), "Bearer fixture-session");
    assert.equal(api.calls[1].options.cache, "no-store");
    assert.equal(result.status, 409);
    assert.equal(result.error.raw.code, conflict.code);
    assert.equal(result.data, null, "readback must never make the rejected mutation successful");
    assert.deepEqual(clone(result.conflictRecord), fresh);
    assert.deepEqual(api.delays, []);
  });
}
for (const failure of [
  { readStatus: 503 }, { throwRead: true }, { readBody: { id: "different-game" } }, { readBody: {} },
]) {
  test(`failed/mismatched conflict readback preserves original 409: ${JSON.stringify(failure)}`, async () => {
    const api = client(failure);
    const result = await api.update(stale.id, payload());
    assert.deepEqual(api.calls.map(({ options }) => options.method), ["PATCH", "GET"]);
    assert.equal(result.status, 409);
    assert.equal(result.error.raw.code, conflict.code);
    assert.equal(result.data, null);
    assert.equal(result.conflictRecord, null);
    assert.deepEqual(api.delays, []);
  });
}
for (const options of [{ patchStatus: 403 }, { patchStatus: 428 }, { patchStatus: 503 }, { throwPatch: true }]) {
  test(`non-conflict mutation failure has no replay or readback: ${JSON.stringify(options)}`, async () => {
    const api = client(options);
    const result = await api.update(stale.id, payload());
    assert.equal(api.calls.length, 1);
    assert.equal(result.data, null);
    assert.ok(result.error);
    assert.equal(result.conflictRecord, undefined);
    assert.deepEqual(api.delays, []);
  });
}
test("successful PATCH keeps canonical hydration and does not add a conflict", async () => {
  const api = client({ patchStatus: 200 });
  const result = await api.update(stale.id, payload());
  assert.deepEqual(api.calls.map(({ options }) => options.method), ["PATCH", "GET"]);
  assert.equal(result.status, 200);
  assert.equal(result.error, null);
  assert.deepEqual(clone(result.data), fresh);
  assert.equal(result.conflictRecord, undefined);
});
test("invalid game ID makes no requests", async () => {
  const api = client();
  assert.equal((await api.update(" ", payload())).status, 400);
  assert.deepEqual(api.calls, []);
});

for (const name of ["patchGameRoster", "saveDetailsMetadata"]) {
  for (const readBody of [fresh, {}]) {
    test(`${name}: conflict replaces canonical state only when available, returns failure and clears busy state`, async () => {
      const api = client({ readBody });
      const records = [], errors = [], busy = [], optimistic = [];
      const invoke = callback(name, {
        gameRecordId: stale.id, activeGameRecord: stale, detailsMaxPlayers: 4, waitlistEnabled: true,
        detailsOrganizerHasIdentity: false, detailsParticipants: stale.participants, detailsWaitlist: [],
        getPadelPlayerIdentityKey: (player) => player.id, excludePlayersAlreadyInRoster: (players) => players,
        setUpdatingGameRoster: (value) => busy.push(value), setUpdatingGameMeta: (value) => busy.push(value),
        setGameRosterError: (value) => errors.push(value), setGameDetailsMetaError: (value) => errors.push(value),
        apiUpdatePadelGameRecord: api.update,
        upsertGameRecordInStores: (record, options) => records.push({ record, options }),
        setParticipants: (value) => optimistic.push(value), setWaitlistPlayers: (value) => optimistic.push(value),
      });
      const result = name === "patchGameRoster"
        ? await invoke(payload().participants, [])
        : await invoke({ intended: true }, "fixture fallback");
      assert.equal(result, false);
      assert.deepEqual(busy, [true, false]);
      assert.equal(errors.at(-1), conflict.error);
      assert.deepEqual(optimistic, []);
      assert.deepEqual(clone(records), readBody.id ? [{ record: fresh, options: { communityMode: "if_exists", recordMode: "replace", activeMode: "if_exists" } }] : []);
      assert.deepEqual(api.calls.map(({ options }) => options.method), ["PATCH", "GET"]);
    });
  }
}
for (const [index, source] of pages.entries()) {
  for (const alive of [true, false]) {
    test(`${index === 0 ? "cabinet" : "invite"} background conflict reuses canonical readback and respects cleanup=${!alive}`, async () => {
      const api = client();
      const records = [];
      let current = stale;
      const invoke = background(source, {
        alive, game: stale, activeGameRecord: stale, exerciseId: "fixture-exercise", syncStartedAt: Date.now(),
        detailsSourceParticipants: [], mergedParticipants: [], vivaPlayers: [], detailsLeaveEvents: [],
        reconciliation: { filteredSourcePlayersCount: 0 },
        upsertGameRecordInStores: (record, options) => records.push({ record, options }),
        setGame: (update) => { current = update(current); }, trackRosterSyncEvent: () => {},
        apiFetchPadelGameRecord: () => { throw new Error("409 readback must not be repeated by the page"); },
      });
      await invoke(await api.update(stale.id, payload()));
      if (index === 0) {
        assert.deepEqual(clone(records), alive ? [{ record: fresh, options: { communityMode: "if_exists", recordMode: "replace" } }] : []);
      } else {
        assert.deepEqual(clone(current), alive ? fresh : stale);
      }
      assert.deepEqual(api.calls.map(({ options }) => options.method), ["PATCH", "GET"]);
    });
  }
}

// Exercise every actual invite-page post-PATCH continuation (payment confirmation,
// split payment persistence, ordinary join) up to its error return. Success-only
// notifications, redirects and follow-up requests deliberately have no fixtures.
const inviteContinuations = matches(pages[1], (node) => ts.isBlock(node) && node.statements.some((statement) =>
  ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
    declaration.name.getText(pages[1]) === "updateResult" && declaration.initializer?.getText(pages[1]).startsWith("await apiUpdatePadelGameRecord("))));
assert.equal(inviteContinuations.length, 3);
for (const [index, block] of inviteContinuations.entries()) {
  for (const navigate of [false, true]) {
    test(`invite continuation ${index + 1} reports conflict without success effects; navigation=${navigate}`, async () => {
      const api = client();
      const updateResult = await api.update(stale.id, payload());
      const errors = [], busy = [];
      const previous = navigate ? { id: "another-game", participants: [] } : stale;
      let current = previous;
      const start = block.statements.findIndex((statement) => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some((node) => node.name.getText(pages[1]) === "updateResult"));
      const scope = {
        updateResult, actualGame: stale, setGame: (update) => { current = update(current); },
        setDecisionError: (value) => errors.push(value), setSubmitting: (value) => busy.push(value),
        setConfirmingSplitPaymentRef: (value) => busy.push(value),
      };
      const code = compile(`return (async () => { ${block.statements.slice(start + 1).map((node) => node.getText(pages[1])).join("\n")} });`);
      await new Function(...Object.keys(scope), code)(...Object.values(scope))();
      assert.deepEqual(clone(current), navigate ? previous : fresh, "replace canonical state without switching to an old game");
      assert.deepEqual(errors, [conflict.error]);
      assert.deepEqual(busy, [null]);
      assert.deepEqual(api.calls.map(({ options }) => options.method), ["PATCH", "GET"]);
    });
  }
}

for (const navigate of [false, true]) {
  test(`cabinet canonical conflict replacement preserves current view after navigation=${navigate}`, () => {
    const another = { id: "another-game", participants: [{ id: "other-player" }] };
    let active = navigate ? another : stale;
    let community = [stale, another];
    const upsert = callback("upsertGameRecordInStores", {
      gameRecordId: stale.id, mergePadelGameRecord: (_before, after) => after,
      setActiveGameRecordStore: (update) => { active = update(active); },
      setCommunityGames: (update) => { community = update(community); },
      notifyGameRecordsUpdated: () => {},
    });
    upsert(fresh, { communityMode: "if_exists", recordMode: "replace", activeMode: "if_exists" });
    assert.deepEqual(active, navigate ? another : fresh);
    assert.deepEqual(community, [fresh, another]);
  });
}


test("two concurrent logical PATCH calls have distinct UUIDs, stable in wire and error telemetry, without new headers or body fields", async () => {
  const api = client();
  await Promise.all([api.update(stale.id, payload()), api.update(stale.id, payload())]);
  const writes = api.calls.filter(call => call.options.method === 'PATCH');
  const ids = writes.map(call => new URL(call.url).searchParams.get('__lk_diag_op'));
  assert.equal(new Set(ids).size, 2);
  for (const [index, call] of writes.entries()) {
    assert.equal(new URL(call.url).searchParams.get('__lk_diag_build'), 'b'.repeat(40));
    assert.equal(api.diagnostics.filter(event => event.logicalOperation === ids[index]).length, 1);
    assert.equal(api.diagnostics.find(event => event.logicalOperation === ids[index]).attempt, 1);
    assert.deepEqual(JSON.parse(call.options.body), payload());
    assert.deepEqual([...call.options.headers.keys()].sort(), ['authorization', 'content-type']);
    assert.equal(call.options.diagnosticContext, undefined, 'diagnostic context is not a FetchInit/provider field');
  }
  assert(api.calls.filter(call => call.options.method === 'GET').every(call => !new URL(call.url).searchParams.has('__lk_diag_op')));
});

test("unavailable diagnostic randomness preserves one PATCH, original409 and canonical refresh", async () => {
  const api = client({ diagnosticUnavailable: true });
  const result = await api.update(stale.id, payload());
  assert.deepEqual(api.calls.map(call => call.options.method), ['PATCH', 'GET']);
  assert.equal(api.calls[0].url, 'https://fixture.invalid/lk/games/fixture-game');
  assert.equal(result.status, 409); assert.equal(result.data, null);
  assert.deepEqual(clone(result.conflictRecord), fresh);
});

for (const context of [
  Object.freeze({ logicalOperation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attempt: 0 }),
  { get logicalOperation() { throw Error('fixture malformed diagnostics'); }, attempt: 0 },
]) {
  test("optional frozen/throwing diagnostic context cannot prevent fetch or change its result under strict mode", async () => {
    const api = client({ patchStatus: 200 });
    const result = await api.request('/lk/games/fixture-game', { method: 'PATCH', body: '{}', retries: 0, diagnosticContext: context });
    assert.equal(api.calls.length, 1); assert.equal(result.status, 200); assert.equal(result.error, null);
    if (Object.isFrozen(context)) assert.equal(context.attempt, 0);
  });
}

test("provided logical operation survives two physical attempts with increasing attempt numbers", async () => {
  const api = client({ patchStatus: 503 });
  const logicalOperation = randomUUID();
  const result = await api.request('/lk/games/fixture-game', { method: 'PATCH', body: '{}', retries: 1,
    diagnosticContext: Object.freeze({ logicalOperation, attempt: 0 }) });
  assert.equal(result.status, 503); assert.equal(api.calls.length, 2);
  assert.deepEqual(api.diagnostics.map(event => [event.logicalOperation, event.attempt]), [[logicalOperation, 1], [logicalOperation, 2]]);
});

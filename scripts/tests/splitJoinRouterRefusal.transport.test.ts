// One-time split JOIN: the real Node-RED handlers behind the real apiClient.
//
// The fetch transport does not invent server answers. For /split/join it runs
// scripts/nodered_games_nodes/fn_split_router.js (POST /transactions, then the
// GET /transactions/{id} lookup) or fn_split_join_prepare.js against a synthetic
// Viva and returns exactly the status and body those handlers produce. Every
// provider POST /transactions is counted. Provider and storage stay synthetic:
// this proves the LK handler contract, not Viva behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "split-join-router-refusal-"));
const bundlePath = path.join(bundleDirectory, "apiClient.mjs");
await build({
  entryPoints: ["src/utils/apiClient.ts"],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
process.on("exit", () => fs.rmSync(bundleDirectory, { recursive: true, force: true }));

type Client = typeof import("../../src/utils/apiClient.ts");
let instance = 0;
// A fresh module instance over the same storage = a page reload.
const loadClient = async (): Promise<Client> => import(`${pathToFileURL(bundlePath).href}?instance=${instance += 1}`) as Promise<Client>;

const routerSource = fs.readFileSync("scripts/nodered_games_nodes/fn_split_router.js", "utf8");
const prepareSource = fs.readFileSync("scripts/nodered_games_nodes/fn_split_join_prepare.js", "utf8");
type NodeMessage = { statusCode?: number; payload?: unknown; method?: string; url?: string; _splitCtx?: Record<string, unknown> } | null;
const runNode = (source: string, msg: Record<string, unknown>): NodeMessage[] => {
  const store = new Map<string, unknown>();
  return new Function("msg", "env", "global", source)(msg, { get: () => undefined },
    { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value) }) as NodeMessage[];
};

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

type JoinMode =
  /** Viva created the transaction; the follow-up GET answered with this status. */
  | { kind: "created-then-lookup-fails"; lookupStatus: number; lookupBody: unknown }
  /** Viva refused POST /transactions itself with this status. */
  | { kind: "create-refused"; status: number; body: unknown }
  /** The real join prepare refuses before the router (stored location incomplete). */
  | { kind: "prepare-refuses-location" };

interface Provider {
  joinPosts: string[];
  transactionCreates: Array<{ paymentRef: string; transactionId: string }>;
  transactionLookups: string[];
  mode: JoinMode;
}

// The router context the join prepare hands over right before the create step.
const routerCtxAtTransaction = (gameId: string, paymentRef: string) => ({
  action: "join", step: "transaction", paymentMode: "one_time", gameId, paymentRef, operationId: paymentRef,
  token: "synthetic-service-token", exerciseId: "exercise-1", bookingId: "booking-1", studioId: "studio-1",
  shareAmountMinor: 150000, clientPhone: "79990000000",
});

function serveJoin(provider: Provider, gameId: string, paymentRef: string): { status: number; body: unknown } {
  const mode = provider.mode;
  if (mode.kind === "prepare-refuses-location") {
    const out = runNode(prepareSource, {
      payload: [{ id: gameId, booking: { vivaExerciseId: "exercise-1", studioId: "studio-1" },
        metadata: { splitPayment: { enabled: true, payments: [] } } }],
      _splitJoinGameId: gameId,
      _splitJoinBody: { paymentRef, exerciseId: "exercise-1", studioId: "studio-1", clientPhone: "79990000000", paymentMode: "one_time" },
      req: { headers: { authorization: "Bearer synthetic" }, params: { gameId }, query: {} },
    });
    assert.equal(out[0], null, "the prepare refusal reaches no provider");
    return { status: Number(out[1]?.statusCode), body: out[1]?.payload };
  }
  // POST /transactions: the provider either refuses it or creates the bill.
  if (mode.kind === "create-refused") {
    const out = runNode(routerSource, { statusCode: mode.status, payload: mode.body, _splitCtx: routerCtxAtTransaction(gameId, paymentRef) });
    return { status: Number(out[1]?.statusCode), body: out[1]?.payload };
  }
  const transactionId = `transaction-${provider.transactionCreates.length + 1}`;
  provider.transactionCreates.push({ paymentRef, transactionId });
  // Viva's create answer has the id but no payment link: the router must read the bill.
  const afterCreate = runNode(routerSource, { statusCode: 201, payload: { id: transactionId }, _splitCtx: routerCtxAtTransaction(gameId, paymentRef) });
  const lookup = afterCreate[0];
  assert.equal(lookup?.method, "GET");
  assert.ok(lookup?.url?.endsWith(`/transactions/${transactionId}`), lookup?.url);
  provider.transactionLookups.push(transactionId);
  const afterLookup = runNode(routerSource, { statusCode: mode.lookupStatus, payload: mode.lookupBody, _splitCtx: { ...lookup!._splitCtx } });
  return { status: Number(afterLookup[1]?.statusCode), body: afterLookup[1]?.payload };
}

function installEnvironment(provider: Provider, storage: MemoryStorage) {
  Object.assign(globalThis, {
    window: {
      localStorage: storage, sessionStorage: new MemoryStorage(), location: new URL("https://lk.test/games"),
      navigator: { userAgent: "node-test" }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      setTimeout, clearTimeout,
    },
    localStorage: storage,
  });
  storage.setItem("padlhub_auth_token_v1", JSON.stringify({ token: "synthetic-test-token", expiresAt: null }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://api.test");
    const method = (init?.method || "GET").toUpperCase();
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const join = url.pathname.match(/\/lk\/games\/([^/]+)\/split\/join$/);
    if (method === "POST" && join) {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const paymentRef = String(body.paymentRef || "");
      provider.joinPosts.push(paymentRef);
      const answer = serveJoin(provider, decodeURIComponent(join[1]), paymentRef);
      return json(answer.status, answer.body);
    }
    const read = url.pathname.match(/\/lk\/games\/([^/]+)$/);
    if (method === "GET" && read) {
      // The bill exists at the provider, but no LK item carries this paymentRef yet.
      return json(200, { id: decodeURIComponent(read[1]), status: "PAID", settings: { payMode: "split" }, participants: [],
        metadata: { splitPayment: { enabled: true, payments: [] } } });
    }
    return json(404, { message: "not found" });
  }) as typeof fetch;
  // Node exposes navigator.locks; the client relies on it for the per-game lock.
  assert.ok((globalThis.navigator as Navigator & { locks?: unknown }).locks, "Web Locks are available in this runtime");
}

const joinParams = (paymentRef: string) => ({
  date: "2026-11-20", fromTime: "19:00", toTime: "20:30", exerciseId: "exercise-1", studioId: "studio-1", roomId: "room-1",
  clientId: "client-1", clientPhone: "79990000000", paymentRef, paymentMode: "one_time" as const, clientSubscriptionId: null,
  baseRedirectUrl: null, successUrl: null, failUrl: null, shareCount: 4, shareAmount: 1500, durationMinutes: 90,
  maxClientsCount: 4, spot: null, paymentDeadlineMinutes: 10,
});
const code = (result: { error?: { raw?: unknown } | null }) => (result.error?.raw as { code?: string } | undefined)?.code;

function setup(mode: JoinMode) {
  const provider: Provider = { joinPosts: [], transactionCreates: [], transactionLookups: [], mode };
  const storage = new MemoryStorage();
  installEnvironment(provider, storage);
  return { provider, storage };
}

const lookupFailures: Array<{ name: string; status: number; body: unknown }> = [
  { name: "401", status: 401, body: { message: "Unauthorized" } },
  { name: "403", status: 403, body: { message: "Forbidden" } },
  { name: "404", status: 404, body: { message: "Transaction not found", code: "NOT_FOUND" } },
  { name: "400", status: 400, body: { message: "Bad request" } },
  { name: "422", status: 422, body: { message: "Unprocessable" } },
];

for (const failure of lookupFailures) {
  test(`transaction created, lookup answered ${failure.name}: the attempt stays held and no second bill is created`, async () => {
    const { provider } = setup({ kind: "created-then-lookup-fails", lookupStatus: failure.status, lookupBody: failure.body });
    const client = await loadClient();
    const first = await client.apiCreatePadelSplitParticipantPayment(`game-${failure.name}`, joinParams("ref-A") as never);
    // The real router forwards the provider status unchanged.
    assert.equal(first.error?.status, failure.status, JSON.stringify(first.error));
    assert.deepEqual(provider.transactionCreates.map(item => item.paymentRef), ["ref-A"], "the bill exists at the provider");

    // A repeated action sends no new create (checked first: this is the money outcome).
    const again = await client.apiCreatePadelSplitParticipantPayment(`game-${failure.name}`, joinParams("ref-B") as never);
    assert.deepEqual(provider.transactionCreates.map(item => item.paymentRef), ["ref-A"], "no second provider transaction");
    assert.equal(code(again), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");
    assert.equal(client.getHeldSplitJoinPaymentRef(`game-${failure.name}`), "ref-A", "a failed read after the create proves nothing");
    const reloaded = await loadClient();
    assert.equal(reloaded.getHeldSplitJoinPaymentRef(`game-${failure.name}`), "ref-A");
    const afterReload = await reloaded.apiCreatePadelSplitParticipantPayment(`game-${failure.name}`, joinParams("ref-C") as never);
    assert.equal(code(afterReload), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");
    assert.deepEqual(provider.joinPosts, ["ref-A"], "exactly one join command left the browser");
    assert.equal(provider.transactionCreates.length, 1, "exactly one provider transaction");
  });
}

for (const status of [400, 401, 403, 404, 422]) {
  test(`POST /transactions refused by Viva with ${status}: the provider was reached, so the attempt stays held`, async () => {
    const { provider } = setup({ kind: "create-refused", status, body: { message: "provider refusal" } });
    const client = await loadClient();
    const first = await client.apiCreatePadelSplitParticipantPayment(`game-create-${status}`, joinParams("ref-A") as never);
    assert.equal(first.error?.status, status);
    assert.equal(client.getHeldSplitJoinPaymentRef(`game-create-${status}`), "ref-A");
    const again = await client.apiCreatePadelSplitParticipantPayment(`game-create-${status}`, joinParams("ref-B") as never);
    assert.equal(code(again), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");
    assert.deepEqual(provider.joinPosts, ["ref-A"]);
  });
}

test("a real pre-provider refusal from the join prepare still allows a new deliberate attempt", async () => {
  const { provider } = setup({ kind: "prepare-refuses-location" });
  const client = await loadClient();
  const refused = await client.apiCreatePadelSplitParticipantPayment("game-prepare", joinParams("ref-1") as never);
  assert.equal(refused.error?.status, 400);
  assert.equal((refused.error?.raw as { details?: { code?: string } })?.details?.code, "SPLIT_GAME_LOCATION_INCOMPLETE");
  assert.equal(client.getHeldSplitJoinPaymentRef("game-prepare"), null, "the server proved no provider write for this request");
  const retry = await client.apiCreatePadelSplitParticipantPayment("game-prepare", joinParams("ref-2") as never);
  assert.equal(retry.error?.status, 400, "the new deliberate attempt was sent and refused again for the same reason");
  assert.deepEqual(provider.joinPosts, ["ref-1", "ref-2"]);
  assert.equal(provider.transactionCreates.length, 0);
});

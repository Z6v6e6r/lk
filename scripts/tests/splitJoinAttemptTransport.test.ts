// One-time split JOIN through the real apiClient with a controlled fetch transport.
// Every money command is counted at the transport boundary with its paymentRef.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "split-join-attempt-transport-"));
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
// A fresh module instance over the same storage = a page reload or a second window.
const loadClient = async (): Promise<Client> => import(`${pathToFileURL(bundlePath).href}?instance=${instance += 1}`) as Promise<Client>;

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

type PostMode = "accept-then-lose-response" | "refuse-409" | "accept";
type ReadMode = "fail" | "ok";
interface Server {
  posts: Array<{ gameId: string; paymentRef: string; operationIdQuery: string | null }>;
  postMode: PostMode;
  readMode: ReadMode;
  payments: Array<Record<string, unknown>>;
}

// A checkout that satisfies the deterministic one-time decision contract.
function validJoinCheckout(gameId: string, paymentRef: string) {
  return {
    mode: "join", gameId, paymentRef, operationId: paymentRef, exerciseId: "exercise-1", bookingId: "booking-1",
    transactionId: "transaction-1", paymentUrl: "https://pay.test/checkout", settlementState: "PAYMENT_REQUIRED",
    selectedPaymentMode: "one_time", toPay: 1500, toPayMinor: 150000, amountMinor: 150000, checkoutStored: true,
  };
}

function installEnvironment(server: Server, storage: MemoryStorage) {
  const location = new URL("https://lk.test/games");
  Object.assign(globalThis, {
    window: {
      localStorage: storage, sessionStorage: new MemoryStorage(), location, navigator: { userAgent: "node-test" },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      setTimeout, clearTimeout,
    },
    localStorage: storage,
  });
  storage.setItem("padlhub_auth_token_v1", JSON.stringify({ token: "synthetic-test-token", expiresAt: null }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://api.test");
    const method = (init?.method || "GET").toUpperCase();
    const join = url.pathname.match(/\/lk\/games\/([^/]+)\/split\/join$/);
    if (method === "POST" && join) {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const paymentRef = String(body.paymentRef || "");
      server.posts.push({ gameId: decodeURIComponent(join[1]), paymentRef, operationIdQuery: url.searchParams.get("operationId") });
      if (server.postMode === "refuse-409") {
        return new Response(JSON.stringify({ message: "Последнее место уже занято" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      // The provider accepted the create; the payment exists from now on.
      server.payments.push({ clientId: "client-1", status: "PAYMENT_PENDING", paymentRef, createdAt: new Date().toISOString() });
      if (server.postMode === "accept-then-lose-response") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(validJoinCheckout(decodeURIComponent(join[1]), paymentRef)),
        { status: 201, headers: { "content-type": "application/json" } });
    }
    const read = url.pathname.match(/\/lk\/games\/([^/]+)$/);
    if (method === "GET" && read) {
      if (server.readMode === "fail") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({
        id: decodeURIComponent(read[1]), status: "PAID", settings: { payMode: "split" }, participants: [],
        metadata: { splitPayment: { enabled: true, payments: server.payments } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const joinParams = (paymentRef: string) => ({
  date: "2026-11-20", fromTime: "19:00", toTime: "20:30", exerciseId: "exercise-1", studioId: "studio-1", roomId: "room-1",
  clientId: "client-1", clientPhone: "79990000000", paymentRef, paymentMode: "one_time" as const, clientSubscriptionId: null,
  baseRedirectUrl: null, successUrl: null, failUrl: null, shareCount: 4, shareAmount: 1500, durationMinutes: 90,
  maxClientsCount: 4, spot: null, paymentDeadlineMinutes: 10,
});

function setup(postMode: PostMode = "accept-then-lose-response") {
  const server: Server = { posts: [], postMode, readMode: "ok", payments: [] };
  const storage = new MemoryStorage();
  installEnvironment(server, storage);
  return { server, storage };
}
const code = (result: { error?: { raw?: unknown } | null }) => (result.error?.raw as { code?: string } | undefined)?.code;

test("POST accepted, response lost: the result is unknown and the exact paymentRef is held", async () => {
  const { server } = setup();
  const client = await loadClient();
  const result = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-A") as never);
  assert.equal(result.data, null);
  assert.equal(result.error?.status ?? null, null, "a lost response is not a refusal");
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A"]);
  assert.equal(client.getHeldSplitJoinPaymentRef("game-1"), "ref-A");
});

test("a new key cannot bypass the unknown result: failed read, empty read, expired window, old CANCELLED item", async () => {
  const { server } = setup();
  const client = await loadClient();
  await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-A") as never);
  server.payments.length = 0; // accepted at the provider but not yet projected into the game

  server.readMode = "fail";
  const unreadable = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-B") as never);
  assert.equal(code(unreadable), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");

  server.readMode = "ok";
  const empty = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-C") as never);
  assert.equal(code(empty), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");

  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60 * 60_000; // far past any local payment window
  try {
    const late = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-D") as never);
    assert.equal(code(late), "SPLIT_JOIN_ATTEMPT_UNRESOLVED", "time alone never releases the attempt");
  } finally {
    Date.now = realNow;
  }

  server.payments.push({ clientId: "client-1", status: "CANCELLED", paymentRef: "ref-OLD" });
  const oldCancelled = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-E") as never);
  assert.equal(code(oldCancelled), "SPLIT_JOIN_ATTEMPT_UNRESOLVED", "another attempt's CANCELLED item is not evidence");

  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A"], "exactly one money command was sent");
  assert.equal(client.getHeldSplitJoinPaymentRef("game-1"), "ref-A");
});

test("a pending exact item stays held even after its local deadline; it never opens a second create", async () => {
  const { server } = setup();
  const client = await loadClient();
  await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-A") as never);
  server.payments[0].deadlineAt = new Date(Date.now() - 60_000).toISOString();
  const result = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-B") as never);
  assert.equal(code(result), "SPLIT_JOIN_ATTEMPT_PENDING");
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A"]);
});

test("reload and a second window see the same held attempt and send no new create", async () => {
  const { server } = setup();
  const first = await loadClient();
  await first.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-A") as never);
  server.payments.length = 0;
  const reloaded = await loadClient();
  const secondWindow = await loadClient();
  assert.equal(reloaded.getHeldSplitJoinPaymentRef("game-1"), "ref-A");
  assert.equal(secondWindow.getHeldSplitJoinPaymentRef("game-1"), "ref-A");
  const fromReload = await reloaded.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-R") as never);
  const fromSecond = await secondWindow.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-W") as never);
  assert.equal(code(fromReload), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");
  assert.equal(code(fromSecond), "SPLIT_JOIN_ATTEMPT_UNRESOLVED");
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A"]);

  // Evidence resolved in one window releases the other window too.
  server.payments.push({ clientId: "client-1", status: "CANCELLED", paymentRef: "ref-A" });
  const resolved = await secondWindow.resolveSplitJoinAttempt("game-1");
  assert.equal(resolved.evidence, "terminal");
  assert.equal(first.getHeldSplitJoinPaymentRef("game-1"), null);
});

test("an exact PAID item resolves the attempt without another create", async () => {
  const { server } = setup();
  const client = await loadClient();
  await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-A") as never);
  server.payments[0].status = "PAID";
  const result = await client.apiCreatePadelSplitParticipantPayment("game-1", joinParams("ref-B") as never);
  assert.equal(code(result), "SPLIT_JOIN_ATTEMPT_PAID");
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A"]);
  assert.equal(client.getHeldSplitJoinPaymentRef("game-1"), null);
});

test("a definitive server refusal allows a new deliberate attempt with a new key", async () => {
  const { server } = setup("refuse-409");
  const client = await loadClient();
  const refused = await client.apiCreatePadelSplitParticipantPayment("game-2", joinParams("ref-1") as never);
  assert.equal(refused.error?.status, 409);
  assert.equal(client.getHeldSplitJoinPaymentRef("game-2"), null, "a 409 proves this request created nothing");
  server.postMode = "accept";
  await client.apiCreatePadelSplitParticipantPayment("game-2", joinParams("ref-2") as never);
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-1", "ref-2"]);
  // The synthetic 201 lacks the full checkout contract: an unusable success is
  // still not a refusal, so the new attempt stays held until the record shows it.
  assert.equal(client.getHeldSplitJoinPaymentRef("game-2"), "ref-2");
});

test("a server-terminal exact item allows a new deliberate attempt; exactly one more command is sent", async () => {
  const { server } = setup();
  const client = await loadClient();
  await client.apiCreatePadelSplitParticipantPayment("game-3", joinParams("ref-A") as never);
  server.payments[0].status = "CANCELLED";
  server.postMode = "accept";
  await client.apiCreatePadelSplitParticipantPayment("game-3", joinParams("ref-B") as never);
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A", "ref-B"]);
  assert.ok(server.posts.every(post => post.operationIdQuery === null), "one-time join keeps its paymentRef as the operation id");
});

test("a contract-valid success keeps the attempt held while the exact item is pending, and PAID releases it", async () => {
  const { server } = setup("accept");
  const client = await loadClient();
  const created = await client.apiCreatePadelSplitParticipantPayment("game-4", joinParams("ref-A") as never);
  assert.equal(created.error ?? null, null, JSON.stringify(created.error));
  assert.equal(created.data?.paymentRef, "ref-A");
  assert.equal(client.getHeldSplitJoinPaymentRef("game-4"), "ref-A");
  const second = await client.apiCreatePadelSplitParticipantPayment("game-4", joinParams("ref-B") as never);
  assert.equal(code(second), "SPLIT_JOIN_ATTEMPT_PENDING");
  server.payments[0].status = "PAID";
  assert.equal((await client.resolveSplitJoinAttempt("game-4")).evidence, "paid");
  assert.equal(client.getHeldSplitJoinPaymentRef("game-4"), null);
  assert.deepEqual(server.posts.map(post => post.paymentRef), ["ref-A"]);
});

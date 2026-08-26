import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildCandidate } from "../patch_live_game_payment_confirmation.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const liveCreate = `const incomingPaid = null;
const body = {};
const toStr = (value) => value;
const reqPath = "/lk/games/payment/confirm";
const msg = {};
const explicitAction = toStr(body.action || body._action || msg._action || msg.action);
let mode = "create";
if (reqPath.includes("/payment/confirm")) mode = "confirm";
if (reqPath.includes("/draft")) mode = "draft";
if (explicitAction) {
  const normalized = explicitAction.toLowerCase();
  if (["create", "draft", "confirm"].includes(normalized)) {
    mode = normalized;
  }
}
const fallbackId = "fallback";
const gameId = toStr(body.id || body.gameId || body.recordId) || fallbackId || \`g_\${Date.now()}\`;
const resolvedPaid =
  mode === "draft"
    ? (incomingPaid === null ? false : incomingPaid)
    : mode === "confirm"
      ? true
      : (incomingPaid === null ? true : incomingPaid);

const incomingStatus = toStr(body.status);
const resolvedStatus =
  incomingStatus
  || (mode === "draft"
    ? "PAYMENT_PENDING"
    : resolvedPaid
      ? "PAID"
      : "PAYMENT_PENDING");
const paymentRef = "ref";
const dedupeKey = "dedupe";
const queryFilter = paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": paymentRef },
        { "payment.paymentRef": paymentRef },
      ],
    }
  : { dedupeKey };
const reqPathRaw = reqPath;
const paymentVerification = {};
const dbMsg = Object.assign({}, msg, {
  _requestUrl: reqPathRaw,
  _requestMode: mode,
});
const responseMsg = {};
const debugMsg = {};
const autojoinMsg = {};
return [dbMsg, responseMsg, debugMsg, autojoinMsg];
`;
const beforePrepare = "return msg;";
const beforeRouter = "return msg;";
const contract = {
  flowSha256: "synthetic-preimage",
  nodeCount: 15,
  httpRouteCount: 2,
  tabId: "tab",
  createNode: {
    id: "e656cff36a8cd210",
    name: "Prepare game upsert",
    beforeFuncSha256: sha256(liveCreate),
  },
  mongoWriteNodes: [
    {
      id: "5eaf4c087c0cc668",
      name: "Upsert lk game",
      collection: "lk_games",
      operation: "updateOne",
      maxTimeMS: "5000",
      ackTarget: "confirmWriteAck",
    },
    {
      id: "11079a30bf3cc6ad",
      name: "Archive split game after cleanup",
      collection: "lk_games",
      operation: "updateOne",
      maxTimeMS: "0",
      ackTarget: "cleanupWriteAck",
    },
  ],
  sourceTargets: [
    {
      id: "9508f8e0ae8d282a",
      name: "Prepare split cleanup tasks",
      beforeFuncSha256: sha256(beforePrepare),
      source: "fn_split_cleanup_prepare.js",
    },
    {
      id: "bcc3dccf8d64f9bb",
      name: "Route split cleanup action",
      beforeFuncSha256: sha256(beforeRouter),
      source: "fn_split_cleanup_router.js",
    },
    {
      id: "79307f9bcbc28b6c",
      name: "Upsert lk game -> mongodb4 args",
      beforeFuncSha256: sha256(beforeRouter),
      source: "fn_game_upsert_args.js",
    },
  ],
  routes: [
    { id: "715662c56fc5eac6", name: "LK games payment confirm", url: "/lk/games/payment/confirm" },
    { id: "4d960c11d162d102", name: "LK games confirm alias", url: "/lk/games/confirm" },
  ],
};

const flow = () => [
  { id: "tab", type: "tab", wires: [] },
  { id: "ae5ee70de15fe66e", type: "http response", z: "tab", wires: [] },
  { id: "60a3353902ae9973", type: "debug", z: "tab", wires: [] },
  { id: "e656cff36a8cd210", type: "function", z: "tab", name: "Prepare game upsert", func: liveCreate, wires: [[], [], [], []] },
  { id: "9508f8e0ae8d282a", type: "function", z: "tab", name: "Prepare split cleanup tasks", func: beforePrepare, wires: [[]] },
  {
    id: "bcc3dccf8d64f9bb",
    type: "function",
    z: "tab",
    name: "Route split cleanup action",
    func: beforeRouter,
    outputs: 4,
    wires: [
      ["41d9d40fefc3b1f3"],
      ["ed88ec81ce95b8b0"],
      ["e71d73fb91b0c3f0"],
      ["ba322f367a4d4fcd"],
    ],
  },
  { id: "79307f9bcbc28b6c", type: "function", z: "tab", name: "Upsert lk game -> mongodb4 args", func: beforeRouter, wires: [[]] },
  { id: "5eaf4c087c0cc668", type: "mongodb4", z: "tab", name: "Upsert lk game", clientNode: "4e820638cc39c730", mode: "collection", collection: "lk_games", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, wires: [[]] },
  { id: "11079a30bf3cc6ad", type: "mongodb4", z: "tab", name: "Archive split game after cleanup", clientNode: "4e820638cc39c730", mode: "collection", collection: "lk_games", operation: "updateOne", output: "toArray", maxTimeMS: "0", handleDocId: false, wires: [[]] },
  { id: "41d9d40fefc3b1f3", type: "debug", z: "tab", wires: [] },
  { id: "ed88ec81ce95b8b0", type: "debug", z: "tab", wires: [] },
  { id: "e71d73fb91b0c3f0", type: "debug", z: "tab", wires: [] },
  { id: "ba322f367a4d4fcd", type: "debug", z: "tab", wires: [] },
  { id: "715662c56fc5eac6", type: "http in", z: "tab", name: "LK games payment confirm", method: "post", url: "/lk/games/payment/confirm", wires: [["e656cff36a8cd210"]] },
  { id: "4d960c11d162d102", type: "http in", z: "tab", name: "LK games confirm alias", method: "post", url: "/lk/games/confirm", wires: [["e656cff36a8cd210"]] },
];

test("guarded builder adds the verified payment pipeline and preserves routes", () => {
  const result = buildCandidate(flow(), "synthetic-preimage", { contract });
  assert.equal(result.report.candidateNodeCount, contract.nodeCount + 12);
  assert.equal(result.report.httpRouteCount, contract.httpRouteCount);
  assert.equal(result.report.brokenWires, 0);
  assert.equal(result.report.brokenLinks, 0);
  const canonical = result.candidate.find((node) => node.id === "715662c56fc5eac6");
  const alias = result.candidate.find((node) => node.id === "4d960c11d162d102");
  assert.deepEqual(canonical.wires, [["lk_game_payment_confirm_lookup_20260826"]]);
  assert.deepEqual(alias.wires, [["lk_game_payment_confirm_lookup_20260826"]]);
  assert.match(result.candidate.find((node) => node.id === "e656cff36a8cd210").func, /GAME_PAYMENT_EVIDENCE_REQUIRED/);
  assert.match(result.candidate.find((node) => node.id === "e656cff36a8cd210").func, /status: "PAYMENT_PENDING"/);
  assert.match(result.candidate.find((node) => node.id === "e656cff36a8cd210").func, /_gameConfirmWriteAck/);
  assert.deepEqual(
    result.candidate.find((node) => node.id === "5eaf4c087c0cc668").wires,
    [["lk_game_payment_confirm_write_ack_20260826"]],
  );
  assert.deepEqual(
    result.candidate.find((node) => node.id === "11079a30bf3cc6ad").wires,
    [["lk_split_cleanup_write_ack_20260826"]],
  );
  assert.match(result.candidate.find((node) => node.id === "lk_game_payment_confirm_write_ack_20260826").func, /GAME_PAYMENT_CAS_MISS/);
  assert.match(result.candidate.find((node) => node.id === "lk_split_cleanup_write_ack_20260826").func, /SPLIT_CLEANUP_CAS_MISS/);
});

test("guarded builder rejects whole-flow, function and route drift", () => {
  assert.throws(() => buildCandidate(flow(), "wrong", { contract }), /preimage/i);
  const functionDrift = flow();
  functionDrift.find((node) => node.id === "e656cff36a8cd210").func = "drift";
  assert.throws(() => buildCandidate(functionDrift, "synthetic-preimage", { contract }), /function preimage/i);
  const routeDrift = flow();
  routeDrift.find((node) => node.id === "715662c56fc5eac6").wires = [["unexpected"]];
  assert.throws(() => buildCandidate(routeDrift, "synthetic-preimage", { contract }), /wiring drift/i);
});

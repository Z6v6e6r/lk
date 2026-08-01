import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type Msg = Record<string, any>;

const nodeDir = "scripts/nodered_chat_nodes";

function run(fileName: string, msg: Msg): any[] {
  const source = fs.readFileSync(`${nodeDir}/${fileName}`, "utf8");
  return new Function("msg", source)(msg) as any[];
}

function authenticatedRoute(params: {
  method: string;
  path: string;
  payload?: Msg;
  query?: Msg;
  gameId?: string;
}) {
  const msg: Msg = {
    payload: params.payload ?? {},
    req: {
      method: params.method,
      path: params.path,
      params: params.gameId ? { gameId: params.gameId } : {},
      query: params.query ?? {},
      headers: { authorization: "Bearer verified-user-token" },
    },
  };
  const prepared = run("fn_chat_auth_prepare.js", msg)[0];
  assert.ok(prepared);
  prepared.statusCode = 200;
  prepared.payload = {
    id: "client-1",
    phone: "+7 (999) 000-00-01",
    firstName: "Verified",
    lastName: "Player",
  };
  return prepared;
}

test("chat auth gate returns 401 before profile lookup when Bearer is missing", () => {
  const msg: Msg = {
    payload: {},
    req: {
      method: "GET",
      path: "/lk/games/game-1/chat/messages",
      params: { gameId: "game-1" },
      headers: {},
    },
  };
  const out = run("fn_chat_auth_prepare.js", msg);
  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 401);
  assert.equal(out[1].payload.code, "CHAT_AUTH_TOKEN_REQUIRED");
  assert.equal(out[1].url, undefined);
});

test("chat auth gate forwards only the Bearer and preserves the original request body", () => {
  const originalPayload = {
    text: "hello",
    senderPhone: "79990000001",
    senderId: "client-1",
  };
  const msg: Msg = {
    payload: originalPayload,
    req: {
      method: "POST",
      path: "/lk/games/game-1/chat/messages",
      params: { gameId: "game-1" },
      headers: { authorization: "Bearer verified-user-token" },
    },
  };
  const out = run("fn_chat_auth_prepare.js", msg);
  assert.equal(out[1], null);
  assert.equal(out[0].method, "GET");
  assert.match(out[0].url, /\/profile$/u);
  assert.deepEqual(out[0].headers, {
    Authorization: "Bearer verified-user-token",
    Accept: "application/json",
  });
  assert.deepEqual(out[0]._chatAuth.requestPayload, originalPayload);
  assert.equal(out[0].payload, undefined);
});

test("invalid profile response fails closed and never reaches a chat route", () => {
  const prepared = authenticatedRoute({
    method: "GET",
    path: "/lk/games/game-1/chat/messages",
    gameId: "game-1",
  });
  prepared.statusCode = 401;
  prepared.payload = { error: "invalid token" };
  const out = run("fn_chat_auth_resolve.js", prepared);
  assert.deepEqual(out.slice(0, 4), [null, null, null, null]);
  assert.equal(out[4].statusCode, 401);
  assert.equal(out[4].payload.code, "CHAT_AUTH_TOKEN_INVALID");
});

test("body and query identity spoofing are rejected against the verified profile", () => {
  const send = authenticatedRoute({
    method: "POST",
    path: "/lk/games/game-1/chat/messages",
    gameId: "game-1",
    payload: { text: "forged", senderPhone: "79990000002" },
  });
  const sendOut = run("fn_chat_auth_resolve.js", send);
  assert.equal(sendOut[0], null);
  assert.equal(sendOut[4].statusCode, 403);
  assert.equal(sendOut[4].payload.code, "CHAT_ACTOR_IDENTITY_MISMATCH");

  const list = authenticatedRoute({
    method: "GET",
    path: "/lk/chats/by-phone",
    query: { phone: "79990000002" },
  });
  const listOut = run("fn_chat_auth_resolve.js", list);
  assert.equal(listOut[3], null);
  assert.equal(listOut[4].statusCode, 403);
});

test("verified profile dispatches all four exact chat routes", () => {
  const cases = [
    { method: "POST", path: "/lk/games/game-1/chat/messages", gameId: "game-1", output: 0 },
    { method: "GET", path: "/lk/games/game-1/chat/messages", gameId: "game-1", output: 1 },
    { method: "POST", path: "/lk/games/game-1/chat/read", gameId: "game-1", output: 2 },
    { method: "GET", path: "/lk/chats/by-phone", output: 3 },
  ];
  for (const item of cases) {
    const prepared = authenticatedRoute(item);
    const out = run("fn_chat_auth_resolve.js", prepared);
    assert.ok(out[item.output]);
    assert.equal(out[item.output]._chatActor.verified, true);
    assert.equal(out[item.output]._chatActor.phoneNorm, "79990000001");
    assert.equal(out[item.output]._chatActor.clientId, "client-1");
    assert.equal(out[4], null);
  }
});

test("all four prepare functions require the verified server-side actor", () => {
  const cases = [
    ["fn_chat_post_prepare_secure.js", { payload: { text: "hello" }, req: { params: { gameId: "game-1" } } }],
    ["fn_chat_get_prepare_secure.js", { payload: {}, req: { params: { gameId: "game-1" }, query: {} } }],
    ["fn_chat_read_prepare_secure.js", { payload: {}, req: { params: { gameId: "game-1" }, query: {} } }],
    ["fn_chat_list_prepare_secure.js", { payload: {}, req: { query: {} } }],
  ] as const;
  for (const [fileName, msg] of cases) {
    const out = run(fileName, structuredClone(msg));
    assert.equal(out[0], null, fileName);
    assert.equal(out[1].statusCode, 401, fileName);
    assert.equal(out[1].payload.code, "CHAT_AUTH_REQUIRED", fileName);
    assert.equal(out[1].headers["Access-Control-Allow-Origin"], "*", fileName);
    assert.equal(out[1].headers["Cache-Control"], "no-store", fileName);
  }
});

test("send preparation uses verified profile identity, never body identity", () => {
  const prepared = authenticatedRoute({
    method: "POST",
    path: "/lk/games/game-1/chat/messages",
    gameId: "game-1",
    payload: {
      text: "hello",
      senderPhone: "79990000001",
      senderId: "client-1",
      senderName: "Forged Name",
    },
  });
  const resolved = run("fn_chat_auth_resolve.js", prepared)[0];
  const out = run("fn_chat_post_prepare_secure.js", resolved);
  assert.equal(out[1], null);
  assert.equal(out[0]._chat.senderPhone, "79990000001");
  assert.equal(out[0]._chat.senderId, "client-1");
  assert.equal(out[0]._chat.senderName, "Verified Player");
});

test("verified former member is denied while a current participant remains allowed", () => {
  const basePrepared = authenticatedRoute({
    method: "GET",
    path: "/lk/games/game-1/chat/messages",
    gameId: "game-1",
    query: { phone: "79990000001" },
  });
  const resolved = run("fn_chat_auth_resolve.js", basePrepared)[1];
  const queryMsg = run("fn_chat_get_prepare_secure.js", resolved)[0];

  const formerMsg = structuredClone(queryMsg);
  formerMsg.payload = [{
    id: "game-1",
    allRelatedPhones: ["79990000001"],
    participantPhones: ["79990000001"],
    participants: [],
    waitlist: [],
    metadata: { splitPayment: { payments: [{ phoneNorm: "79990000001", status: "LEFT" }] } },
  }];
  const former = run("fn_chat_get_build_query_secure.js", formerMsg);
  assert.equal(former[0], null);
  assert.equal(former[1].statusCode, 403);

  const activeMsg = structuredClone(queryMsg);
  activeMsg.payload = [{
    id: "game-1",
    participants: [{ id: "client-1", phone: "79990000001", status: "CONFIRMED" }],
    waitlist: [],
    metadata: { splitPayment: { payments: [] } },
  }];
  const active = run("fn_chat_get_build_query_secure.js", activeMsg);
  assert.ok(active[0]);
  assert.equal(active[1], null);
});

test("chat list derives message query only from active server-side game ids", () => {
  const prepared = authenticatedRoute({
    method: "GET",
    path: "/lk/chats/by-phone",
    query: { phone: "79990000001" },
  });
  const resolved = run("fn_chat_auth_resolve.js", prepared)[3];
  const gameQuery = run("fn_chat_list_prepare_secure.js", resolved)[0];
  assert.equal(gameQuery.payload.relatedPhones, undefined);
  assert.equal(gameQuery._chatList.verified, true);

  gameQuery.payload = [
    {
      id: "active-game",
      participants: [{ id: "client-1", phone: "79990000001", status: "CONFIRMED" }],
      waitlist: [],
      metadata: { splitPayment: { payments: [] } },
    },
    {
      id: "historical-only",
      allRelatedPhones: ["79990000001"],
      participantPhones: ["79990000001"],
      participants: [],
      waitlist: [],
      metadata: { splitPayment: { payments: [{ phoneNorm: "79990000001", status: "CANCELLED" }] } },
    },
    {
      id: "someone-else",
      participants: [{ phone: "79990000002", status: "CONFIRMED" }],
      waitlist: [],
      metadata: { splitPayment: { payments: [] } },
    },
  ];
  const out = run("fn_chat_list_build_messages_query.js", gameQuery);
  assert.equal(out[1], null);
  assert.deepEqual(out[0]._chatList.activeGameIds, ["active-game"]);
  assert.deepEqual(out[0].payload, {
    gameId: { $in: ["active-game"] },
    deleted: { $ne: true },
  });
  assert.equal(out[0].payload.relatedPhones, undefined);
});

test("chat list denies a mixed no-id and foreign-id collision on the verified phone", () => {
  const prepared = authenticatedRoute({
    method: "GET",
    path: "/lk/chats/by-phone",
    query: { phone: "79990000001" },
  });
  const resolved = run("fn_chat_auth_resolve.js", prepared)[3];
  const gameQuery = run("fn_chat_list_prepare_secure.js", resolved)[0];
  gameQuery.payload = [{
    id: "ambiguous-game",
    participants: [
      { phone: "79990000001", status: "CONFIRMED" },
      { id: "foreign-client", phone: "79990000001", status: "CONFIRMED" },
    ],
    waitlist: [],
    metadata: { splitPayment: { payments: [] } },
  }];

  const out = run("fn_chat_list_build_messages_query.js", gameQuery);
  assert.equal(out[1], null);
  assert.deepEqual(out[0]._chatList.activeGameIds, []);
  assert.deepEqual(out[0].payload, {
    gameId: { $in: [] },
    deleted: { $ne: true },
  });
});

test("chat list post-auth guard keeps CORS and no-store on early rejection", () => {
  const out = run("fn_chat_list_build_messages_query.js", { payload: [] });
  assert.equal(out[1].statusCode, 401);
  assert.equal(out[1].headers["Access-Control-Allow-Origin"], "*");
  assert.equal(out[1].headers["Cache-Control"], "no-store");
});

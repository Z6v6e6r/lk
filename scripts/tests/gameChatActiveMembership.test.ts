import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type UnknownRecord = Record<string, unknown>;

const CASES = [
  {
    file: "scripts/nodered_chat_nodes/fn_chat_get_build_query_secure.js",
    contextKey: "_chatGet",
    context: { gameId: "game-1", phone: "79990000001", clientId: "client-1", beforeTs: Date.now() },
  },
  {
    file: "scripts/nodered_chat_nodes/fn_chat_post_build_insert_secure.js",
    contextKey: "_chat",
    context: {
      gameId: "game-1",
      senderPhone: "79990000001",
      senderId: "client-1",
      senderName: "Игрок",
      type: "TEXT",
      text: "Сообщение",
    },
  },
  {
    file: "scripts/nodered_chat_nodes/fn_chat_read_insert_secure.js",
    contextKey: "_chatRead",
    context: { gameId: "game-1", phone: "79990000001", clientId: "client-1", lastReadTs: Date.now() },
  },
] as const;

function runNodeRedFunction(file: string, msg: UnknownRecord): unknown[] {
  const source = fs.readFileSync(file, "utf8");
  const execute = new Function("msg", source) as (value: UnknownRecord) => unknown[];
  return execute(msg);
}

function runCase(
  item: (typeof CASES)[number],
  game: UnknownRecord,
): { outputs: unknown[]; response: UnknownRecord; success: UnknownRecord | null } {
  const msg: UnknownRecord = {
    payload: [game],
    [item.contextKey]: structuredClone(item.context),
  };
  const outputs = runNodeRedFunction(item.file, msg);
  return {
    outputs,
    response: msg,
    success: outputs[0] && typeof outputs[0] === "object"
      ? outputs[0] as UnknownRecord
      : null,
  };
}

for (const item of CASES) {
  test(`${item.file} denies a former member present only in historical fields`, () => {
    const { outputs, response } = runCase(item, {
      id: "game-1",
      allRelatedPhones: ["+7 999 000-00-01"],
      participantPhones: ["79990000001"],
      invitedPhones: ["79990000001"],
      metadata: {
        allRelatedPhones: ["79990000001"],
        participantPhones: ["79990000001"],
        splitPayment: {
          payments: [{ clientPhoneNorm: "79990000001", status: "LEFT" }],
        },
      },
      participants: [],
      waitlist: [],
    });

    assert.equal(outputs[0], null);
    assert.equal(response.statusCode, 403);
    assert.equal((response.headers as UnknownRecord)["Access-Control-Allow-Origin"], "*");
    assert.equal((response.headers as UnknownRecord)["Cache-Control"], "no-store");
  });

  test(`${item.file} allows a current participant`, () => {
    const { success, response } = runCase(item, {
      id: "game-1",
      participants: [{ phone: "+7 (999) 000-00-01", status: "CONFIRMED" }],
      waitlist: [],
      metadata: { splitPayment: { payments: [] } },
    });

    assert.equal(response.statusCode, undefined);
    assert.ok(success);
  });

  test(`${item.file} fails closed when the game has no active members`, () => {
    const { outputs, response } = runCase(item, {
      id: "game-1",
      participants: [],
      waitlist: [],
      metadata: { splitPayment: { payments: [] } },
    });

    assert.equal(outputs[0], null);
    assert.equal(response.statusCode, 403);
  });

  test(`${item.file} denies a distinct strong client id that shares the verified phone`, () => {
    const { outputs, response } = runCase(item, {
      id: "game-1",
      participants: [{ id: "client-foreign", phone: "79990000001", status: "CONFIRMED" }],
      waitlist: [],
      metadata: { splitPayment: { payments: [] } },
    });
    assert.equal(outputs[0], null);
    assert.equal(response.statusCode, 403);
  });

  test(`${item.file} denies phone fallback when a no-id row shares the phone with a foreign strong id`, () => {
    const { outputs, response } = runCase(item, {
      id: "game-1",
      participants: [
        { phone: "79990000001", status: "CONFIRMED" },
        { id: "client-foreign", phone: "79990000001", status: "CONFIRMED" },
      ],
      waitlist: [],
      metadata: { splitPayment: { payments: [] } },
    });
    assert.equal(outputs[0], null);
    assert.equal(response.statusCode, 403);
  });

  test(`${item.file} denies archived and cancelled games`, () => {
    for (const state of [{ archived: true }, { status: "CANCELLED" }]) {
      const { outputs, response } = runCase(item, {
        id: "game-1",
        participants: [{ id: "client-1", phone: "79990000001", status: "CONFIRMED" }],
        waitlist: [],
        metadata: { splitPayment: { payments: [] } },
        ...state,
      });
      assert.equal(outputs[0], null);
      assert.equal(response.statusCode, 403);
    }
  });
}

test("chat message relatedPhones contains active identities only", () => {
  const item = CASES[1];
  const { response, success } = runCase(item, {
    id: "game-1",
    organizer: { phoneNorm: "79990000002" },
    allRelatedPhones: ["79990000003"],
    participants: [{ phone: "79990000001", status: "CONFIRMED" }],
    waitlist: [],
    metadata: {
      splitPayment: {
        payments: [{ clientPhoneNorm: "79990000003", status: "CANCELLED" }],
      },
    },
  });

  assert.equal(response.statusCode, undefined);
  assert.ok(success);
  assert.deepEqual((success.payload as UnknownRecord).relatedPhones, [
    "79990000002",
    "79990000001",
  ]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readNodeRedFunctionSource(file: string) {
  return fs.readFileSync(file, "utf8");
}

function runNodeRedFunction(
  file: string,
  msg: Record<string, unknown>,
  envValues: Record<string, string> = {},
) {
  const source = readNodeRedFunctionSource(file);
  const env = {
    get(key: string) {
      return envValues[key] ?? null;
    },
  };
  return new Function("msg", "env", source)(msg, env);
}

test("MAX client lookup passes MAX channel identities to support resolve", () => {
  const result = runNodeRedFunction("scripts/nodered_max_nodes/fn_max_client_lookup_prepare.js", {
    maxUpdate: {
      sender: { userId: "101978776" },
      recipient: { chatId: "108894081" },
      contact: null,
    },
  }) as Record<string, any>;

  const url = new URL(result.url);
  assert.equal(url.pathname, "/api/support/clients/resolve");
  assert.equal(url.searchParams.get("channel"), "MAX");
  assert.equal(url.searchParams.get("connector"), "MAX_BOT");
  assert.equal(url.searchParams.get("channelUserId"), "101978776");
  assert.equal(url.searchParams.get("userId"), "101978776");
  assert.equal(url.searchParams.get("chatId"), "108894081");
});

test("MAX route reuses AUTHORIZED client station and emits local support fields", () => {
  const result = runNodeRedFunction(
    "scripts/nodered_max_nodes/fn_max_support_route.js",
    {
      maxUpdate: {
        messageKind: "text",
        text: "К",
        messageId: "mid.1",
        sender: { userId: "101978776", name: "Клиент" },
        recipient: { chatId: "108894081" },
      },
      payload: {
        client: {
          authStatus: "AUTHORIZED",
          lastStationId: "tereh",
          lastStationName: "Терехово",
        },
      },
    },
    { SUPPORT_API_BASE_URL: "http://127.0.0.1:3000/api" },
  ) as any[];

  const supportEventMsg = result[0] as Record<string, any>;
  const outbound = result[1] as Array<Record<string, any>>;

  assert.equal(outbound.length, 0);
  assert.equal(supportEventMsg.payload.channel, "MAX");
  assert.equal(supportEventMsg.payload.connector, "MAX_BOT");
  assert.equal(supportEventMsg.payload.eventType, "MESSAGE");
  assert.equal(supportEventMsg.payload.stationId, "tereh");
  assert.equal(supportEventMsg.payload.stationName, "Терехово");
  assert.equal(supportEventMsg.payload.chatId, "108894081");
  assert.equal(supportEventMsg.payload.channelUserId, "101978776");
});

test("MAX station selection persists selected station into support event payload", () => {
  const result = runNodeRedFunction(
    "scripts/nodered_max_nodes/fn_max_support_route.js",
    {
      maxUpdate: {
        messageKind: "station",
        text: "Терехово",
        station: { id: "tereh", name: "Терехово" },
        messageId: "mid.2",
        sender: { userId: "101978776", name: "Клиент" },
        recipient: { chatId: "108894081" },
      },
      payload: {
        client: {
          authStatus: "AUTHORIZED",
        },
      },
    },
    { SUPPORT_API_BASE_URL: "http://127.0.0.1:3000/api" },
  ) as any[];

  const supportEventMsg = result[0] as Record<string, any>;
  const outbound = result[1] as Array<Record<string, any>>;

  assert.equal(supportEventMsg.payload.eventType, "STATION_SELECTED");
  assert.equal(supportEventMsg.payload.stationId, "tereh");
  assert.equal(supportEventMsg.payload.stationName, "Терехово");
  assert.equal(supportEventMsg.payload.selectedStationId, "tereh");
  assert.equal(outbound.length, 1);
  assert.match(String(outbound[0]?.payload?.text || outbound[0]?.payload), /Станция Терехово сохранена/);
});

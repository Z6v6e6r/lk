import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type NodeRedMsg = Record<string, unknown>;

function runNodeRedFunction(file: string, msg: NodeRedMsg) {
  const source = fs.readFileSync(file, "utf8");
  const globalContext = {
    get() {
      return undefined;
    },
    set() {},
  };
  return new Function("msg", "global", source)(msg, globalContext);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("list normalize drops stale phone matches when user is absent from actual roster and active split payment", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_list_normalize.js", {
    _lkPhone: "79998704790",
    _lkIncludePast: true,
    payload: [
      {
        id: "pay_stale",
        status: "PAID",
        organizer: {
          id: "org-1",
          phoneNorm: "79035107512",
        },
        participantPhones: ["79035107512", "79998704790"],
        allRelatedPhones: ["79035107512", "79998704790"],
        participants: [
          {
            id: "org-1",
            phone: "79035107512",
            status: "CONFIRMED",
          },
        ],
        waitlist: [],
        invitedPhones: [],
        metadata: {
          splitPayment: {
            payments: [
              {
                clientId: "org-1",
                phoneNorm: "79035107512",
                status: "PAID",
              },
              {
                clientId: "p-2",
                phoneNorm: "79998704790",
                status: "EXPIRED",
              },
            ],
          },
        },
      },
    ],
  }) as unknown[];

  const response = asRecord(out[0]);
  const payload = asRecord(response.payload);
  assert.deepEqual(payload.games, []);
  assert.equal(payload.total, 0);
});

test("list normalize keeps an active Viva participant matched only by clientId", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_list_normalize.js", {
    _lkPhone: "79104303190",
    _lkClientId: "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
    _lkIncludePast: true,
    payload: [
      {
        id: "pay_2cdad417-7ff8-4dc9-9cc5-066e701e10ad",
        status: "PAID",
        organizer: {
          id: "7a3b22fe-077b-478b-b59e-3b5b9df0985c",
          phoneNorm: "79091561343",
        },
        participants: [
          {
            id: "7a3b22fe-077b-478b-b59e-3b5b9df0985c",
            phone: "79091561343",
            status: "CONFIRMED",
          },
          {
            id: "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
            phone: null,
            status: "CONFIRMED",
          },
        ],
        waitlist: [],
        invitedPhones: [],
        metadata: {
          splitPayment: { payments: [] },
        },
      },
    ],
  }) as unknown[];

  const response = asRecord(out[0]);
  const payload = asRecord(response.payload);
  const games = payload.games as Array<Record<string, unknown>>;

  assert.equal(payload.total, 1);
  assert.equal(games[0]?.id, "pay_2cdad417-7ff8-4dc9-9cc5-066e701e10ad");
});

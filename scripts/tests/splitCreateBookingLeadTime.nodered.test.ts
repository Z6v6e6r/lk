import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_split_create_prepare.js",
  "utf8",
);

type NodeRedMessage = {
  method?: string;
  url?: string;
  statusCode?: number;
  payload?: { details?: { code?: string; minLeadMinutes?: number } };
  _splitCtx?: { step?: string };
};

function runCreate(nowIso: string, paymentMode: "one_time" | "subscription") {
  class FixedDate extends Date {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...(args.length ? args : [nowIso]));
    }

    static now() {
      return Date.parse(nowIso);
    }
  }

  const msg = {
    payload: {
      date: "2026-08-26",
      fromTime: "13:50",
      toTime: "15:20",
      studioId: "studio-1",
      roomId: "room-1",
      clientPhone: "79990000001",
      paymentMode,
      ...(paymentMode === "subscription"
        ? { clientSubscriptionId: "client-subscription-1" }
        : {}),
    },
  };
  const globalContext = { get: () => null, set: () => undefined };
  const env = { get: () => null };

  return new Function("msg", "Date", "global", "env", source)(
    msg,
    FixedDate,
    globalContext,
    env,
  ) as Array<NodeRedMessage | null>;
}

for (const paymentMode of ["one_time", "subscription"] as const) {
  test(`${paymentMode}: a start exactly 30 minutes away proceeds to the first read-only request`, () => {
    const outputs = runCreate("2026-08-26T10:20:00.000Z", paymentMode);

    assert.equal(outputs[0]?.method, "GET");
    assert.match(outputs[0]?.url, /\/advertising\/split-payment-promo\?/);
    assert.equal(outputs[0]?._splitCtx?.step, "pricing_policy");
  });

  test(`${paymentMode}: a start 29 minutes 59 seconds away fails before any external request`, () => {
    const outputs = runCreate("2026-08-26T10:20:01.000Z", paymentMode);
    const error = outputs[1];

    assert.equal(outputs[0], null);
    assert.equal(error?.statusCode, 409);
    assert.equal(error?.payload?.details?.code, "BOOKING_LEAD_TIME_TOO_SHORT");
    assert.equal(error?.payload?.details?.minLeadMinutes, 30);
    assert.equal(error?.method, undefined);
    assert.equal(error?.url, undefined);
    assert.equal(error?._splitCtx, undefined);
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

test("split router maps subscription daily limit payload to 409 response", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 409,
    payload: {
      details: {
        code: "SUBSCRIPTION_DAILY_LIMIT_REACHED",
        existingEvent: {
          title: "Игра + тренер",
          studioName: "РА",
          timeLabel: "10:00-11:30",
        },
      },
    },
    _splitCtx: {
      step: "create_booking",
      action: "join",
      paymentMode: "subscription",
      selectedPaymentMode: "subscription",
      clientSubscriptionId: "subscription-1",
      exerciseId: "exercise-2",
      clientPhone: "79990000001",
      shareCount: 4,
      oneTimeBaseAmount: 10000,
      shareAmount: 2500,
      subscriptionVisitCount: 1,
    },
  }) as unknown[];

  const errorMsg = out[1] as {
    statusCode?: number;
    payload?: {
      error?: string;
      details?: {
        code?: string;
        existingEvent?: { title?: string };
      };
    };
  };
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.details?.code, "SUBSCRIPTION_DAILY_LIMIT_REACHED");
  assert.equal(errorMsg.payload?.details?.existingEvent?.title, "Игра + тренер");
  assert.match(errorMsg.payload?.error ?? "", /Подписка позволяет/);
  assert.match(errorMsg.payload?.error ?? "", /на завтра/);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  GameCreateScheduleReadError,
  readGameCreateSchedule,
} from "../lib/gameCreateScheduleRead.mjs";
import { createGameCreateScheduleServer } from "../game-create-schedule-qa.mjs";

const stationId = "3656cbaa-6426-490f-a44f-915404cbdd2b";
const roomId = "a6c94564-a2bf-4d1b-b13c-b41b0796fb30";
const residencyId = "d30d5898-21c3-4f94-8b0a-1f23cbbdab70";
const day = "2026-12-06";
const clock = Date.parse(day + "T05:00:00+03:00");
const auth = `Bearer ${randomUUID()}`;
const request = {
  query: { stationId, day, durationMinutes: "60" },
  authorization: auth,
  correlationId: "synthetic-test-1",
};
const slot = {
  id: "example-slot",
  roomId,
  roomName: "Корт №1",
  date: day,
  timeFrom: "07:00",
  timeTo: "08:30",
};

test("asks Viva for the LK1-owned schedule and binds a quote to a current available slot", async () => {
  const calls = [];
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw);
    calls.push([url.origin, url.pathname, options.method]);
    assert.equal(options.headers.Authorization, auth);
    assert.equal(options.redirect, "error");
    if (url.pathname.endsWith("/timeslots")) {
      assert.equal(url.hostname, "api.vivacrm.ru");
      assert.equal(JSON.parse(options.body).roomFormat, "FULL_ROOM");
      return Response.json({
        timeslots: [
          slot,
          { ...slot, timeFrom: "09:00", timeTo: "09:30" },
          { ...slot, timeFrom: "10:00", timeTo: "11:00", available: false },
          { ...slot, timeFrom: "04:00", timeTo: "05:30" },
        ],
      });
    }
    if (url.pathname.endsWith("/price")) {
      assert.equal(url.searchParams.get("roomId"), roomId);
      assert.equal(url.searchParams.get("fromTime"), "07:00:00");
      assert.equal(url.searchParams.get("toTime"), "08:00:00");
      return Response.json({
        [url.searchParams.get("subServiceIds")]: {
          calculation: {
            fixture: { basePrice: { valueFrom: 4000 }, impacts: [] },
          },
        },
      });
    }
    if (url.pathname.endsWith("/subscriptions")) {
      return Response.json([
        {
          clientSubscriptionId: residencyId,
          productId: "4037a3a3-e551-4f9a-a9db-1410e46b8635",
        },
      ]);
    }
    assert.equal(
      url.href,
      "https://padlhub.su/lk/subscriptions/game-price-preview",
    );
    const body = JSON.parse(options.body);
    const p = body.target;
    assert.deepEqual(body.subscriptionIds, [residencyId]);
    assert.equal(p.slotId, "example-slot");
    return Response.json({
      quotes: [
        {
          subscriptionId: residencyId,
          selectionKey: JSON.stringify([
            p.slotId,
            p.stationId,
            p.roomId,
            p.masterServiceId,
            p.subServiceIds,
            p.startsAt,
            p.durationMinutes,
            4,
          ]),
          basePriceMinor: 100000,
          amountMinor: 70000,
          status: "AVAILABLE",
          evaluatedAt: clock,
          expiresAt: clock + 30000,
          freeMinutes: 0,
          paidMinutes: 60,
        },
      ],
    });
  };
  const options = { fetchImpl, now: () => clock };
  const response = await readGameCreateSchedule(request, options);
  assert.equal(response.slots.length, 1);
  assert.equal(response.slots[0].startsAt, day + "T07:00:00+03:00");
  assert.equal(response.slots[0].endsAt, day + "T08:00:00+03:00");
  const quote = await readGameCreateSchedule(
    { ...request, query: { ...request.query, slotId: response.slots[0].id } },
    options,
  );
  assert.deepEqual(quote, {
    wholeCourtMinor: 400000,
    shareMinor: 100000,
    residency: { status: "APPLIED", amountMinor: 70000 },
    currency: "RUB",
    observedAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 30000).toISOString(),
  });
  assert.deepEqual(
    calls.map(([, path]) => path.split("/").pop()),
    ["timeslots", "timeslots", "price", "subscriptions", "game-price-preview"],
  );
  await assert.rejects(
    readGameCreateSchedule(
      { ...request, query: { ...request.query, slotId: "0".repeat(64) } },
      options,
    ),
    (error) =>
      error instanceof GameCreateScheduleReadError && error.status === 409,
  );
  assert.equal(calls.at(-1)[1].endsWith("/timeslots"), true);
});

test("rejects an unknown station before any outbound read", async () => {
  const fetchImpl = async () => assert.fail("unexpected outbound request");
  await assert.rejects(
    readGameCreateSchedule(
      {
        ...request,
        query: {
          ...request.query,
          stationId: "https://untrusted.invalid/",
        },
      },
      { fetchImpl, now: () => clock },
    ),
    (error) => error.status === 400,
  );
});

test("QA HTTP ingress accepts only that GET and requires actor credentials", async (t) => {
  const server = createGameCreateScheduleServer({
    fetchImpl: async () => assert.fail("unexpected outbound request"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/lk/integrations/v1/game-create-schedule`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { method: "POST", headers: { authorization: auth } }))
      .status,
    404,
  );
  assert.equal(
    (await fetch(url + "?day=x&day=y", { headers: { authorization: auth } }))
      .status,
    400,
  );
});

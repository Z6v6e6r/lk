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
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), auth);
    assert.equal(
      headers.get("user-agent"),
      url.hostname === "api.vivacrm.ru" ? "PadlHub-LK/1.0" : null,
    );
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
      assert.equal(url.searchParams.get("fromDate"), day);
      assert.equal(url.searchParams.get("fromTime"), "07:00");
      assert.equal(url.searchParams.get("toTime"), "08:00");
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

const grouped = (slots) => ({ byTrainer: { noTrainer: { slots } } });
const fragment = (from, to, fields = {}) => ({
  roomId,
  roomName: "Корт №1",
  timeFrom: day + "T" + from + ":00+03:00",
  timeTo: day + "T" + to + ":00+03:00",
  ...fields,
});
const readGrouped = (payload, durationMinutes = "60") =>
  readGameCreateSchedule(
    { ...request, query: { ...request.query, durationMinutes } },
    { now: () => clock, fetchImpl: async () => Response.json(payload) },
  );

test("only continuous available Viva fragments on the same court cover the requested duration", async () => {
  const continuous = [
    fragment("07:00", "07:30"),
    fragment("07:30", "08:00"),
    fragment("08:00", "08:30"),
    fragment("08:30", "09:00"),
  ];
  for (const [duration, starts] of [
    ["60", 3],
    ["90", 2],
    ["120", 1],
  ]) {
    const response = await readGrouped(
      grouped(continuous.map((row) => [row])),
      duration,
    );
    assert.equal(response.slots.length, starts);
    assert.equal(response.slots[0].startsAt, day + "T07:00:00+03:00");
    assert.equal(
      Date.parse(response.slots[0].endsAt) -
        Date.parse(response.slots[0].startsAt),
      Number(duration) * 60_000,
    );
  }
  assert.deepEqual(
    (await readGrouped(grouped([continuous[0], continuous[2]]))).slots,
    [],
  );
  assert.deepEqual(
    (
      await readGrouped(
        grouped([continuous[0], { ...continuous[1], roomId: randomUUID() }]),
      )
    ).slots,
    [],
  );
  assert.deepEqual(
    (
      await readGrouped(
        grouped([
          continuous[0],
          continuous[1],
          { ...continuous[1], available: false },
        ]),
      )
    ).slots,
    [],
  );
});

test("rejects competing or malformed Viva slot groups", async () => {
  for (const payload of [
    { ...grouped([[slot]]), slots: [slot] },
    { byTrainer: { one: { slots: [[slot]] }, two: { slots: [[slot]] } } },
    { byTrainer: { one: { timeSlots: [[slot]] } } },
    grouped(Array.from({ length: 2001 }, () => slot)),
  ]) {
    await assert.rejects(readGrouped(payload), (error) => error.status === 503);
  }
});

test("an incomplete subscription list preserves the base quote and reads the verified LK1 status", async () => {
  const payload = grouped([
    [fragment("07:00", "07:30"), fragment("07:30", "08:00")],
  ]);
  const {
    slots: [selection],
  } = await readGrouped(payload);
  const status = {
    schemaVersion: 1,
    state: "NONE",
    source: "VIVA_OWNED_SUBSCRIPTIONS",
    validFrom: null,
    validUntil: null,
    observedAt: new Date(clock - 1000).toISOString(),
  };
  const paths = [];
  const result = await readGameCreateSchedule(
    { ...request, query: { ...request.query, slotId: selection.id } },
    {
      now: () => clock,
      fetchImpl: async (raw) => {
        const url = new URL(raw);
        paths.push(url.pathname.split("/").at(-1));
        if (url.pathname.endsWith("/timeslots")) return Response.json(payload);
        if (url.pathname.endsWith("/price"))
          return Response.json({
            [url.searchParams.get("subServiceIds")]: {
              calculation: {
                fixture: { basePrice: { valueFrom: 4000 }, impacts: [] },
              },
            },
          });
        if (url.hostname === "api.vivacrm.ru") return Response.json([]);
        assert.equal(url.href, "https://padlhub.su/lk/residency/status");
        return Response.json(status);
      },
    },
  );
  assert.equal(result.wholeCourtMinor, 400000);
  assert.equal(result.shareMinor, 100000);
  assert.deepEqual(result.residency, { status: "NOT_APPLICABLE" });
  assert.equal(Date.parse(result.expiresAt), Date.parse(status.observedAt) + 30000);
  assert.deepEqual(paths, ["timeslots", "price", "subscriptions", "status"]);
});

test("an owned legacy instance needs the LK1 quote for the exact product and slot", async () => {
  const payload = grouped([
    [fragment("07:00", "07:30"), fragment("07:30", "08:00")],
  ]);
  const {
    slots: [selection],
  } = await readGrouped(payload);
  const friendshipId = "568e3c9a-6cee-4e81-bd5a-2b28d0630b38";
  const productId = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
  for (const { quotedProduct, variant, expected } of [
    { quotedProduct: productId, expected: { status: "APPLIED", amountMinor: 42000 } },
    { quotedProduct: friendshipId },
    { quotedProduct: undefined },
    { quotedProduct: productId, variant: "another-slot" },
    { quotedProduct: productId, variant: "expired" },
    { quotedProduct: productId, variant: "zero" },
    { quotedProduct: productId, variant: "duplicate" },
  ]) {
    const result = await readGameCreateSchedule(
      { ...request, query: { ...request.query, slotId: selection.id } },
      {
        now: () => clock,
        fetchImpl: async (raw, options) => {
          const url = new URL(raw);
          if (url.pathname.endsWith("/timeslots")) return Response.json(payload);
          if (url.pathname.endsWith("/price"))
            return Response.json({
              [url.searchParams.get("subServiceIds")]: {
                calculation: { fixture: { basePrice: { valueFrom: 2400 }, impacts: [] } },
              },
            });
          if (url.pathname.endsWith("/subscriptions"))
            return Response.json({
              first: true,
              last: true,
              totalElements: 2,
              content: [friendshipId, residencyId].map((subscriptionId) => ({
                subscriptionId,
                status: "ACTIVE",
              })),
            });
          if (url.pathname.endsWith("/game-price-preview")) {
            const { target, subscriptionIds } = JSON.parse(options.body);
            assert.deepEqual(subscriptionIds, [friendshipId, residencyId]);
            const selectionKey = JSON.stringify([
              target.slotId, target.stationId, target.roomId, target.masterServiceId,
              target.subServiceIds, target.startsAt, target.durationMinutes, 4,
            ]);
            return Response.json({
              quotes: subscriptionIds.map((subscriptionId, index) => ({
                subscriptionId,
                selectionKey: variant === "another-slot" && index === 1 ? "another-slot" : selectionKey,
                status: "AVAILABLE", reasonCode: null,
                ...(index === 1 || variant === "duplicate"
                  ? { appliedSubscriptionProductId: quotedProduct }
                  : {}),
                subscriptionName: "Резидентство ПадлхАБ",
                basePriceMinor: 60000,
                amountMinor: variant === "duplicate" || (index === 1 && variant !== "zero") ? 42000 : 0,
                paidMinutes: 60, freeMinutes: 0,
                evaluatedAt: clock - 1000,
                expiresAt: variant === "expired" ? clock : clock + 20000,
              })),
            });
          }
          assert.equal(url.href, "https://padlhub.su/lk/residency/status");
          return new Response(null, { status: 401 });
        },
      },
    );
    assert.deepEqual(result.residency, expected ?? { status: "UNAVAILABLE" });
    assert.equal(result.shareMinor, 60000);
  }
});

test("returns only an owned, applicable and current subscription price when requested", async () => {
  const payload = grouped([
    [fragment("07:00", "07:30"), fragment("07:30", "08:00")],
  ]);
  const { slots: [selection] } = await readGrouped(payload);
  const regularId = "c43d48cc-72d6-4821-a5b0-f1fcc271e1e4";
  const expiredId = "2042defa-c252-40da-b6ef-e01df2ac4752";
  const residencyProductId = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
  const planProductId = "df11efb7-2b2f-4951-bbf5-e4ae827a7fc2";

  for (const [includeSubscriptionQuote, mode, expected] of [
    [false, "eligible", undefined],
    [true, "eligible", 0],
    [true, "paid", 32000],
    [true, "multiple", 10000],
    [true, "partial-page", undefined],
    [true, "duplicate", undefined],
    [true, "other-slot", undefined],
    [true, "no-minutes", undefined],
    [true, "used", undefined],
    [true, "residency-product", undefined],
  ]) {
    const result = await readGameCreateSchedule(
      { ...request, query: { ...request.query, slotId: selection.id }, includeSubscriptionQuote },
      {
        now: () => clock,
        fetchImpl: async (raw, options) => {
          const url = new URL(raw);
          if (url.pathname.endsWith("/timeslots")) return Response.json(payload);
          if (url.pathname.endsWith("/price")) {
            return Response.json({
              [url.searchParams.get("subServiceIds")]: {
                calculation: { fixture: { basePrice: { valueFrom: 2400 }, impacts: [] } },
              },
            });
          }
          if (url.pathname.endsWith("/subscriptions")) {
            const content = [
              { clientSubscriptionId: residencyId, productId: residencyProductId, status: "ACTIVE" },
              { subscriptionId: regularId, status: "ACTIVE" },
              { subscriptionId: expiredId, status: "ACTIVE" },
            ];
            return Response.json(mode === "partial-page"
              ? { first: true, last: false, totalElements: 4, content }
              : content);
          }
          if (url.pathname.endsWith("/residency/status")) return new Response(null, { status: 503 });
          assert.equal(url.pathname, "/lk/subscriptions/game-price-preview");
          const { target, subscriptionIds } = JSON.parse(options.body);
          const quotesPlans = includeSubscriptionQuote && mode !== "partial-page";
          assert.deepEqual(subscriptionIds, quotesPlans
            ? [residencyId, regularId, expiredId]
            : [residencyId]);
          const selectionKey = JSON.stringify([
            target.slotId, target.stationId, target.roomId, target.masterServiceId,
            target.subServiceIds, target.startsAt, target.durationMinutes, 4,
          ]);
          const quote = {
            selectionKey, status: "AVAILABLE", reasonCode: null, basePriceMinor: 60000,
            evaluatedAt: clock - 1000, expiresAt: clock + 20000,
          };
          const withCopay = mode === "paid" || mode === "multiple";
          return Response.json({ quotes: [
            { ...quote, subscriptionId: residencyId, amountMinor: 42000, freeMinutes: 0,
              paidMinutes: 60, appliedSubscriptionProductId: residencyProductId },
            ...(quotesPlans ? [
              { ...quote, subscriptionId: regularId, amountMinor: withCopay ? 32000 : 0,
                selectionKey: mode === "other-slot" ? "other-slot" : selectionKey,
                status: mode === "used" ? "LIMIT_USED" : "AVAILABLE",
                paidMinutes: withCopay ? 30 : mode === "no-minutes" ? 60 : 0,
                freeMinutes: withCopay ? 30 : mode === "no-minutes" ? 0 : 60,
                ...(mode === "residency-product" ? { appliedSubscriptionProductId: residencyProductId } : {}),
              },
              { ...quote, subscriptionId: mode === "duplicate" ? regularId : expiredId,
                amountMinor: mode === "multiple" ? 10000 : 0,
                paidMinutes: mode === "multiple" ? 30 : 0,
                freeMinutes: mode === "multiple" ? 30 : 60,
                appliedSubscriptionProductId: planProductId,
                expiresAt: mode === "multiple" ? clock + 18000 : clock },
            ] : []),
          ] });
        },
      },
    );
    assert.equal(result.subscriptionMinor, expected, mode);
    assert.deepEqual(result.residency, mode === "duplicate"
      ? { status: "UNAVAILABLE" }
      : { status: "APPLIED", amountMinor: 42000 }, mode);
    if (mode === "multiple") assert.equal(Date.parse(result.expiresAt), clock + 18000);
    assert.equal(JSON.stringify(result).includes(regularId), false);
  }
});

test("price denial leaves exact amounts unknown and preserves only verified LK1 status", async () => {
  const payload = grouped([
    [fragment("07:00", "07:30"), fragment("07:30", "08:00")],
  ]);
  const {
    slots: [selection],
  } = await readGrouped(payload);
  const good = {
    schemaVersion: 1,
    state: "ACTIVE",
    source: "CUP_RESIDENCY_POLICY",
    validFrom: new Date(clock - 60_000).toISOString(),
    validUntil: day + "T08:30:00+03:00",
    observedAt: new Date(clock).toISOString(),
  };
  for (const [status, expected] of [
    [good, "ACTIVE_UNQUOTED"],
    [
      { ...good, observedAt: new Date(clock - 29_000).toISOString() },
      "ACTIVE_UNQUOTED",
    ],
    [{ ...good, source: "OTHER" }, "UNAVAILABLE"],
    [
      { ...good, observedAt: new Date(clock - 31_000).toISOString() },
      "UNAVAILABLE",
    ],
    [{ ...good, validUntil: day + "T07:30:00+03:00" }, "NOT_APPLICABLE"],
    [{ ...good, validFrom: day + "T06:00:00+03:00" }, "UNAVAILABLE"],
    [
      {
        ...good,
        state: "NONE",
        source: "VIVA_OWNED_SUBSCRIPTIONS",
        validFrom: null,
        validUntil: null,
      },
      "NOT_APPLICABLE",
    ],
    [null, "UNAVAILABLE"],
  ]) {
    const paths = [];
    const result = await readGameCreateSchedule(
      { ...request, query: { ...request.query, slotId: selection.id } },
      {
        now: () => clock,
        fetchImpl: async (raw, options) => {
          const url = new URL(raw);
          paths.push([
            url.origin,
            url.pathname.split("/").at(-1),
            options.method,
          ]);
          if (url.pathname.endsWith("/timeslots"))
            return Response.json(payload);
          if (url.pathname.endsWith("/price"))
            return new Response(null, { status: 403 });
          assert.equal(url.href, "https://padlhub.su/lk/residency/status");
          return Response.json(status);
        },
      },
    );
    assert.equal(result.wholeCourtMinor, null);
    assert.equal(result.shareMinor, null);
    assert.deepEqual(result.residency, { status: expected });
    if (expected === "ACTIVE_UNQUOTED")
      assert.equal(
        Date.parse(result.expiresAt),
        Date.parse(status.observedAt) + 30_000,
      );
    assert.deepEqual(
      paths.map(([, path]) => path),
      ["timeslots", "price", "status"],
    );
  }
  await assert.rejects(
    readGameCreateSchedule(request, {
      now: () => clock,
      fetchImpl: async () => new Response(null, { status: 403 }),
    }),
    (error) => error.status === 401,
  );
});

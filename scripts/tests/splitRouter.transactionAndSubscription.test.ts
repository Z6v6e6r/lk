import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  const values = new Map<string, unknown>();
  const env = {
    get(name: string) {
      if (name === "VIVA_SERVICE_USERNAME") return "service@example.test";
      if (name === "VIVA_SERVICE_PASSWORD") return "test-password";
      return undefined;
    },
  };
  const globalContext = {
    get(name: string) { return values.get(name); },
    set(name: string, value: unknown) { values.set(name, value); },
  };
  return new Function("msg", "env", "global", source)(msg, env, globalContext);
}

type RouterMessage = {
  method?: string;
  url?: string;
  requestTimeout?: number;
  statusCode?: number;
  payload?: {
    error?: string;
    details?: {
      code?: string;
      requestedClientSubscriptionId?: string;
      actualClientSubscriptionId?: string;
      expectedAmountMinor?: number | null;
      providerAmountMinor?: number | null;
      expectedTransactionId?: string | null;
      actualTransactionId?: string | null;
    };
    subscriptionProductId?: string;
    paymentModes?: Array<{ productId?: string }>;
    transactionId?: string;
    paymentUrl?: string;
    operationId?: string;
    gameId?: string | null;
    settlementState?: string;
    paymentType?: string;
    clientSubscriptionId?: string;
    count?: number;
    directionId?: number;
    typeId?: number;
    direction?: number;
    type?: number;
    timeFrom?: string;
    timeTo?: string;
    roomId?: string;
    maxClientsCount?: number;
    trainers?: string[];
    requirements?: unknown[];
    clientId?: string;
  };
};

type RouterRequestMessage = RouterMessage & {
  _splitCtx: { step?: string };
  [key: string]: unknown;
};

test("exercise create request matches the current documented Viva ExerciseCreateRequest", () => {
  const tokenOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "service-token", expires_in: 300 },
    _splitCtx: {
      step: "token",
      action: "create",
      paymentMode: "one_time",
      date: "2026-08-22",
      fromTime: "11:30",
      toTime: "13:00",
      studioId: "studio-1",
      roomId: "room-1",
      masterServiceId: "master-service-1",
      subServiceIds: ["sub-service-1"],
      userAuthHeader: "Bearer user-token",
      shareCount: 4,
      maxClientsCount: 4,
      clientId: "client-must-not-be-forwarded",
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
    },
  }) as Array<Record<string, any> | null>;

  const roomLookup = tokenOut[0];
  assert.equal(roomLookup?.method, "GET");
  assert.match(roomLookup?.url || "", /\/studios\/studio-1\/rooms\/room-1$/);

  const subServicesOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    ...roomLookup,
    statusCode: 200,
    payload: { id: "room-1" },
  }) as unknown[];

  const studiosRequest = subServicesOut[0] as RouterMessage;
  assert.equal(studiosRequest.method, "GET");
  assert.match(studiosRequest.url || "", /master-services\/master-service-1\/studios/);

  const studiosOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    ...studiosRequest,
    statusCode: 200,
    payload: [{ id: "studio-1" }],
  }) as unknown[];
  const subServicesRequest = studiosOut[0] as RouterMessage;
  assert.equal(subServicesRequest.method, "GET");
  assert.match(subServicesRequest.url || "", /master-services\/master-service-1\/subServices/);

  const priceOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    ...subServicesRequest,
    statusCode: 200,
    payload: [{ id: "sub-service-1" }],
  }) as unknown[];
  const priceRequest = priceOut[0] as RouterMessage;
  assert.equal(priceRequest.method, "GET");
  assert.match(priceRequest.url || "", /master-services\/master-service-1\/price\?/);

  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    ...priceRequest,
    statusCode: 200,
    payload: { "sub-service-1": { price: 8000 } },
  }) as unknown[];

  const requestMsg = out[0] as RouterMessage;
  assert.equal(requestMsg.method, "POST");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/exercises");
  assert.equal((requestMsg as Record<string, any>)._splitCtx?.totalAmount, 8000);
  assert.equal((requestMsg as Record<string, any>)._splitCtx?.shareAmount, 2000);
  assert.deepEqual(requestMsg.payload, {
    directionId: 4588,
    typeId: 1613,
    timeFrom: "2026-08-22T11:30+03:00",
    timeTo: "2026-08-22T13:00+03:00",
    maxClientsCount: 4,
    roomId: "room-1",
    trainers: [],
    requirements: [],
  });
  assert.equal(Object.hasOwn(requestMsg.payload || {}, "direction"), false);
  assert.equal(Object.hasOwn(requestMsg.payload || {}, "type"), false);
  assert.equal(Object.hasOwn(requestMsg.payload || {}, "clientId"), false);
});

test("fresh-token one-time join verifies room-studio binding before booking", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "service-token", expires_in: 300 },
    _splitCtx: {
      step: "token",
      action: "join",
      paymentMode: "one_time",
      exerciseId: "exercise-1",
      studioId: "studio-1",
      roomId: "room-1",
      clientPhone: "79990000001",
      tokenSource: "refresh",
    },
  }) as Array<Record<string, any> | null>;

  const roomLookup = out[0];
  assert.equal(roomLookup?.method, "GET");
  assert.match(roomLookup?.url || "", /\/studios\/studio-1\/rooms\/room-1$/);
  assert.equal(roomLookup?.requestTimeout, 20000);
  assert.equal(roomLookup?._splitCtx?.step, "verify_room_studio");
});

test("join proves the stored hourly rate against the organizer payment before booking", () => {
  const tokenOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "service-token", expires_in: 300 },
    _splitCtx: {
      step: "token",
      action: "join",
      paymentMode: "one_time",
      exerciseId: "exercise-piter-1",
      studioId: "studio-piter",
      roomId: "room-piter-1",
      clientPhone: "79990000002",
      pricingPolicy: {
        id: "piter-split-250-per-hour-v1",
        pricingMode: "PER_PARTICIPANT_HOUR",
        currency: "RUB",
        twoTeamsHourlyAmount: 500,
        fourPlayersHourlyAmount: 250,
      },
      pricingPolicyProof: {
        transactionId: "tx-organizer-piter-1",
        bookingId: "booking-organizer-piter-1",
        clientId: "client-organizer-piter-1",
        expectedAmountMinor: 37500,
      },
    },
  }) as Array<Record<string, any> | null>;

  const proofLookup = tokenOut[0];
  assert.equal(proofLookup?.method, "GET");
  assert.match(proofLookup?.url || "", /\/transactions\/tx-organizer-piter-1$/);
  assert.equal(proofLookup?.requestTimeout, 20000);
  assert.equal(proofLookup?._splitCtx?.step, "pricing_policy_proof");

  const proofOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    ...proofLookup,
    statusCode: 200,
    payload: {
      id: "tx-organizer-piter-1",
      status: "PAID",
      client: { id: "client-organizer-piter-1", phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-organizer-piter-1"],
        bookingRequests: [{ exerciseId: "exercise-piter-1" }],
      }],
      amountMinor: 37500,
      currency: "RUB",
    },
  }) as Array<Record<string, any> | null>;

  const roomLookup = proofOut[0];
  assert.equal(roomLookup?.method, "GET");
  assert.match(roomLookup?.url || "", /\/studios\/studio-piter\/rooms\/room-piter-1$/);
  assert.equal(roomLookup?._splitCtx?.pricingPolicyProofVerified, true);
});

test("join rejects a stored hourly rate that differs from the organizer payment", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-organizer-piter-2",
      status: "PAID",
      client: { id: "client-organizer-piter-2", phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-organizer-piter-2"],
        bookingRequests: [{ exerciseId: "exercise-piter-2" }],
      }],
      amountMinor: 50000,
      currency: "RUB",
    },
    _splitCtx: {
      step: "pricing_policy_proof",
      action: "join",
      paymentMode: "one_time",
      exerciseId: "exercise-piter-2",
      studioId: "studio-piter",
      roomId: "room-piter-2",
      pricingPolicyProof: {
        transactionId: "tx-organizer-piter-2",
        bookingId: "booking-organizer-piter-2",
        clientId: "client-organizer-piter-2",
        expectedAmountMinor: 25000,
      },
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.details?.code, "SPLIT_PRICING_POLICY_PROOF_INVALID");
});

test("subscription booking request sends the exact selected client subscription id through the atomic gateway", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "token" },
    req: {
      headers: {
        authorization: "Bearer user-token",
      },
      query: { operationId: "split-idem-1" },
    },
    _splitCtx: {
      step: "token",
      action: "join",
      paymentMode: "subscription",
      clientSubscriptionId: "new-subscription",
      clientPhone: "79990000001",
      exerciseId: "exercise-1",
      durationMinutes: 120,
      spot: 1,
    },
  }) as unknown[];

  const requestMsg = out[3] as RouterMessage & {
    _subscriptionBooking?: {
      operationId?: string;
      exerciseId?: string;
      clientSubscriptionId?: string;
      subscriptionVisitCount?: number;
    };
  };
  assert.equal(requestMsg.method, "GET");
  assert.match(requestMsg.url || "", /\/profile$/);
  assert.equal(requestMsg._subscriptionBooking?.operationId, "split-idem-1");
  assert.equal(requestMsg._subscriptionBooking?.exerciseId, "exercise-1");
  assert.equal(requestMsg._subscriptionBooking?.clientSubscriptionId, "new-subscription");
  assert.equal(requestMsg._subscriptionBooking?.subscriptionVisitCount, 2);
});

test("subscription booking router rejects a product id used in place of clientSubscriptionId", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "token" },
    req: {
      headers: { authorization: "Bearer user-token" },
      query: { operationId: "split-idem-missing-selection" },
    },
    _splitCtx: {
      step: "token",
      action: "join",
      paymentMode: "subscription",
      subscriptionId: "product-template-only",
      clientPhone: "79990000001",
      exerciseId: "exercise-1",
      durationMinutes: 60,
      spot: 1,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 400);
  assert.equal(errorMsg.payload?.error, "clientSubscriptionId is required for subscription payment");
});

test("subscription booking fails when Viva confirms a different client subscription", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      clientSubscriptionId: "friendship-subscription",
      client: { id: "client-1", phone: "79990000001" },
      studio: { id: "studio-1" },
      spot: 1,
    },
    _splitCtx: {
      step: "create_booking",
      action: "create",
      paymentMode: "subscription",
      selectedPaymentMode: "subscription",
      clientSubscriptionId: "sport-subscription",
      shareCount: 4,
      oneTimeBaseAmount: 10000,
      shareAmount: 2500,
      paymentRef: "split-ref-1",
      exerciseId: "exercise-1",
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
      totalAmount: 10000,
      deadlineAt: null,
      assembleDeadlineAt: null,
      spot: 1,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Viva списала другой абонемент");
  assert.equal(errorMsg.payload?.details?.requestedClientSubscriptionId, "sport-subscription");
  assert.equal(errorMsg.payload?.details?.actualClientSubscriptionId, "friendship-subscription");
});

test("subscription booking response keeps the actual matched client subscription id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-1",
      clientSubscriptionId: "sport-subscription",
      client: { id: "client-1", phone: "79990000001" },
      studio: { id: "studio-1" },
      spot: 1,
    },
    _splitCtx: {
      step: "create_booking",
      action: "create",
      paymentMode: "subscription",
      selectedPaymentMode: "subscription",
      clientSubscriptionId: "sport-subscription",
      shareCount: 4,
      oneTimeBaseAmount: 10000,
      shareAmount: 2500,
      paymentRef: "split-ref-2",
      exerciseId: "exercise-2",
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
      totalAmount: 10000,
      deadlineAt: null,
      assembleDeadlineAt: null,
      spot: 1,
    },
  }) as unknown[];

  const responseMsg = out[1] as RouterMessage;
  assert.equal(responseMsg.statusCode, 201);
  assert.equal(responseMsg.payload?.subscriptionProductId, "sport-subscription");
  assert.equal(responseMsg.payload?.paymentModes?.[0]?.productId, "sport-subscription");
});

test("verified room-studio binding starts exact Viva pricing before any mutation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { id: "room-piter-1", name: "Панорамик 1" },
    _splitCtx: {
      step: "verify_room_studio",
      action: "create",
      paymentMode: "one_time",
      studioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
      roomId: "room-piter-1",
      date: "2026-08-24",
      fromTime: "12:00",
      toTime: "13:30",
      maxClientsCount: 4,
      durationMinutes: 90,
      shareCount: 4,
      masterServiceId: "master-piter-1",
      subServiceIds: ["sub-piter-1"],
      userAuthHeader: "Bearer user-token",
    },
  }) as Array<Record<string, any> | null>;

  const requestMsg = out[0];
  assert.equal(requestMsg?.method, "GET");
  assert.match(requestMsg?.url || "", /master-services\/master-piter-1\/studios/);
  assert.equal(requestMsg?._splitCtx?.verifiedStudioId, "1ea77cbf-bc36-49a1-96d6-f35c216a409b");
  assert.equal(requestMsg?._splitCtx?.verifiedRoomId, "room-piter-1");
});

test("room-studio mismatch is rejected before any Viva mutation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: { id: "room-other-studio" },
    _splitCtx: {
      step: "verify_room_studio",
      action: "create",
      paymentMode: "one_time",
      studioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
      roomId: "room-piter-1",
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Viva не подтвердила корт выбранной станции");
});

test("missing room under the quoted studio is rejected before any Viva mutation", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 404,
    payload: { error: "not found" },
    _splitCtx: {
      step: "verify_room_studio",
      action: "create",
      paymentMode: "one_time",
      studioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
      roomId: "room-other-studio",
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Корт не принадлежит выбранной станции");
});

test("one-time booking uses the preverified location when response omits studioId", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-without-studio",
      client: { id: "client-1", phone: "79990000001" },
    },
    _splitCtx: {
      step: "create_booking",
      action: "create",
      paymentMode: "one_time",
      studioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
      roomId: "room-piter-1",
      verifiedStudioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
      verifiedRoomId: "room-piter-1",
    },
  }) as Array<Record<string, any> | null>;

  const requestMsg = out[0];
  assert.equal(requestMsg?.method, "POST");
  assert.match(requestMsg?.url || "", /products\/available\/by-booking$/);
  assert.equal(requestMsg?._splitCtx?.studioId, "1ea77cbf-bc36-49a1-96d6-f35c216a409b");
});

test("Piter hourly policy resolves 60, 90 and 120 minutes and ignores browser amounts", () => {
  for (const [durationMinutes, expectedRubles] of [[60, 250], [90, 375], [120, 500]]) {
    const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
      statusCode: 200,
      payload: [{
        id: "one-time-product",
        productType: "BOOKING_PAYMENT",
        name: "Полная стоимость корта",
        status: "ACTIVE",
        cost: 1000000,
      }],
      _splitCtx: {
        step: "available_products",
        action: "create",
        paymentMode: "one_time",
        clientPhone: "79990000001",
        bookingId: "booking-piter-1",
        studioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
        shareCount: 4,
        durationMinutes,
        shareAmount: 1,
        totalAmount: 1,
        oneTimeBaseAmount: 10000,
        pricingPolicy: {
          id: "piter-split-250-per-hour-v1",
          pricingMode: "PER_PARTICIPANT_HOUR",
          currency: "RUB",
          fourPlayersHourlyAmount: 250,
          version: "2026-08-20T10:00:00.000Z",
        },
      },
    }) as Array<Record<string, any> | null>;

    const transactionRequest = out[0];
    assert.equal(transactionRequest?._splitCtx?.shareAmount, expectedRubles);
    assert.equal(transactionRequest?._splitCtx?.shareAmountMinor, expectedRubles * 100);
    assert.equal(transactionRequest?._splitCtx?.discountAmountMinor, 1000000 - expectedRubles * 100);
  }
});

test("CUP response is accepted only when it contains an explicit selected hourly promo", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      enabled: true,
      selectedPromoId: "piter-split-250-per-hour-v1",
      pricingMode: "PER_PARTICIPANT_HOUR",
      currency: "RUB",
      shareAmounts: { twoTeams: 500, fourPlayers: 250 },
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
    _splitCtx: {
      step: "pricing_policy",
      bookingId: "booking-piter-1",
      clientId: "client-1",
      studioId: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "POST");
  assert.match(out[0]?.url || "", /protocol\/openid-connect\/token$/);
  assert.equal(out[0]?.requestTimeout, 10000);
  assert.equal(out[0]?._splitCtx?.pricingPolicy?.id, "piter-split-250-per-hour-v1");
  assert.equal(out[0]?._splitCtx?.pricingPolicy?.fourPlayersHourlyAmount, 250);
});

test("changed CUP rate is rejected instead of silently charging a different amount", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      enabled: true,
      selectedPromoId: "piter-split-250-per-hour-v1",
      pricingMode: "PER_PARTICIPANT_HOUR",
      currency: "RUB",
      shareAmounts: { twoTeams: 500, fourPlayers: 300 },
    },
    _splitCtx: {
      step: "pricing_policy",
      shareCount: 4,
      expectedPricingPolicy: {
        id: "piter-split-250-per-hour-v1",
        pricingMode: "PER_PARTICIPANT_HOUR",
        currency: "RUB",
        hourlyAmount: 250,
      },
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Цена раздельной оплаты изменилась");
});

test("ordinary pricing divides the exact Viva court price and ignores the nominal 10000 product", () => {
  for (const courtPrice of [6000, 8000, 9000, 10000, 12000, 16000]) {
    const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
      statusCode: 200,
      payload: [{
        id: "one-time-product",
        productType: "BOOKING_PAYMENT",
        name: "Номинальный продукт транзакции",
        status: "ACTIVE",
        cost: 1000000,
      }],
      _splitCtx: {
        step: "available_products",
        action: "create",
        paymentMode: "one_time",
        clientPhone: "79990000001",
        bookingId: "booking-moscow-1",
        studioId: "moscow-station",
        shareCount: 4,
        durationMinutes: 90,
        shareAmount: 1,
        totalAmount: courtPrice,
        oneTimeBaseAmount: 10000,
        pricingPolicy: null,
        exactCourtPriceVerified: true,
      },
    }) as Array<Record<string, any> | null>;

    assert.equal(out[0]?._splitCtx?.shareAmount, courtPrice / 4);
    assert.equal(out[0]?._splitCtx?.shareAmountMinor, courtPrice * 25);
    assert.equal(out[0]?._splitCtx?.discountAmountMinor, 1000000 - courtPrice * 25);
  }
});

test("ordinary pricing fails closed when exact Viva price was not verified", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [{
      id: "one-time-product",
      productType: "BOOKING_PAYMENT",
      name: "Номинальный продукт транзакции",
      status: "ACTIVE",
      cost: 1000000,
    }],
    _splitCtx: {
      step: "available_products",
      action: "join",
      paymentMode: "one_time",
      clientPhone: "79990000001",
      bookingId: "booking-1",
      studioId: "studio-1",
      shareCount: 4,
      totalAmount: 8000,
      pricingPolicy: null,
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.details?.code, "SPLIT_EXACT_PRICE_NOT_VERIFIED");
});

test("exact Viva price lookup rejects a sub-service from another station", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [{ id: "allowed-sub-service" }],
    _splitCtx: {
      step: "ordinary_price_subservices",
      action: "create",
      paymentMode: "one_time",
      masterServiceId: "master-1",
      subServiceIds: ["foreign-sub-service"],
      studioId: "studio-1",
      roomId: "room-1",
      date: "2026-08-22",
      fromTime: "12:00",
      toTime: "13:00",
      userAuthHeader: "Bearer user-token",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.details?.code, "SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH");
});

test("exact Viva price lookup accepts nested provider sub-service groups", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      data: {
        services: [{ subServices: [{ serviceId: "sub-1" }] }],
      },
    },
    _splitCtx: {
      step: "ordinary_price_subservices",
      action: "create",
      paymentMode: "one_time",
      masterServiceId: "master-1",
      subServiceIds: ["sub-1"],
      studioId: "studio-1",
      roomId: "room-1",
      date: "2026-08-22",
      fromTime: "12:00",
      toTime: "13:00",
      userAuthHeader: "Bearer user-token",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "GET");
  assert.match(out[0]?.url || "", /master-services\/master-1\/price\?/);
  assert.match(out[0]?.url || "", /subServiceIds=sub-1/);
});

test("exact Viva price lookup rejects a master-service from another station", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [{ id: "another-studio" }],
    _splitCtx: {
      step: "ordinary_price_studios",
      action: "create",
      paymentMode: "one_time",
      masterServiceId: "foreign-master",
      subServiceIds: ["sub-1"],
      studioId: "studio-1",
      roomId: "room-1",
      date: "2026-08-22",
      fromTime: "12:00",
      toTime: "13:00",
      userAuthHeader: "Bearer user-token",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.details?.code, "SPLIT_EXACT_PRICE_MASTER_SERVICE_MISMATCH");
});

test("exact Viva price parser applies provider calculation impacts before booking", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      "sub-1": {
        calculation: {
          slot: {
            basePrice: { appliedValueFrom: 9000 },
            impacts: [{ value: 1000, impactDirection: "DISCOUNT" }],
          },
        },
      },
    },
    _splitCtx: {
      step: "ordinary_exact_price",
      action: "join",
      paymentMode: "one_time",
      token: "service-token",
      exerciseId: "exercise-1",
      clientPhone: "79990000001",
      studioId: "studio-1",
      roomId: "room-1",
      verifiedStudioId: "studio-1",
      verifiedRoomId: "room-1",
      subServiceIds: ["sub-1"],
      shareCount: 4,
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?.method, "POST");
  assert.match(out[0]?.url || "", /exercises\/exercise-1\/bookings$/);
  assert.equal(out[0]?._splitCtx?.totalAmount, 8000);
  assert.equal(out[0]?._splitCtx?.shareAmount, 2000);
  assert.equal(out[0]?._splitCtx?.exactCourtPriceVerified, true);
});

test("singles ordinary pricing divides the exact Viva court price by two", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [{
      id: "one-time-product",
      productType: "BOOKING_PAYMENT",
      name: "Номинальный продукт транзакции",
      status: "ACTIVE",
      cost: 1000000,
    }],
    _splitCtx: {
      step: "available_products",
      action: "create",
      paymentMode: "one_time",
      clientPhone: "79990000001",
      bookingId: "booking-singles-1",
      studioId: "studio-1",
      shareCount: 2,
      totalAmount: 6000,
      pricingPolicy: null,
      exactCourtPriceVerified: true,
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?._splitCtx?.shareAmount, 3000);
  assert.equal(out[0]?._splitCtx?.shareAmountMinor, 300000);
  assert.equal(out[0]?._splitCtx?.availablePaymentModes?.[0]?.label, "Оплатить 1/2 стоимости");
});

test("ordinary pricing fails closed when the transaction product cannot cover the verified share", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [{
      id: "one-time-product",
      productType: "BOOKING_PAYMENT",
      name: "Номинальный продукт транзакции",
      status: "ACTIVE",
      cost: 1000000,
    }],
    _splitCtx: {
      step: "available_products",
      action: "create",
      paymentMode: "one_time",
      clientPhone: "79990000001",
      bookingId: "booking-expensive-1",
      studioId: "studio-1",
      shareCount: 4,
      totalAmount: 50000,
      pricingPolicy: null,
      exactCourtPriceVerified: true,
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(out[1]?.payload?.details?.code, "SPLIT_TRANSACTION_PRODUCT_AMOUNT_TOO_LOW");
});

test("CUP policy outage fails one-time split pricing closed", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 502,
    payload: { error: "upstream unavailable" },
    _splitCtx: { step: "pricing_policy", action: "create" },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 503);
  assert.equal(errorMsg.payload?.error, "Не удалось проверить тариф раздельной оплаты");
});

test("subscription product resolution never falls back to another subscription or one-time payment", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: [
      {
        id: "control-subscription",
        clientSubscriptionId: "control-subscription",
        productType: "SUBSCRIPTION",
        name: "РА",
        status: "ACTIVE",
        cost: 0,
      },
      {
        id: "one-time-product",
        productType: "BOOKING_PAYMENT",
        name: "Разовая оплата",
        status: "ACTIVE",
        cost: 250000,
      },
    ],
    _splitCtx: {
      step: "available_products",
      action: "join",
      paymentMode: "subscription",
      clientSubscriptionId: "friendship-subscription",
      clientPhone: "79990000001",
      exerciseId: "exercise-1",
      bookingId: "booking-1",
      studioId: "studio-1",
      shareCount: 4,
      shareAmount: 2500,
      oneTimeBaseAmount: 10000,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.error, "Выбранный абонемент недоступен для списания");
  assert.equal(
    errorMsg.payload?.details?.requestedClientSubscriptionId,
    "friendship-subscription",
  );
});

test("transaction step preserves transactionId when Viva returns transactionId field without id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-1",
      paymentUrl: "https://pay.example/tx-1",
      toPay: 250000,
    },
    _splitCtx: {
      step: "transaction",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      paymentRef: "split-ref-3",
      operationId: "split-operation-3",
      gameId: "game-3",
      exerciseId: "exercise-3",
      bookingId: "booking-3",
      shareAmount: 2500,
      shareAmountMinor: 250000,
      baseShareAmount: 2500,
      baseShareAmountMinor: 250000,
      discountAmount: 0,
      discountAmountMinor: 0,
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
      totalAmount: 10000,
      oneTimeBaseAmount: 10000,
      availablePaymentModes: [],
      deadlineAt: null,
      assembleDeadlineAt: null,
      spot: 2,
      reusedConflictingExercise: false,
    },
  }) as unknown[];

  const responseMsg = out[1] as RouterMessage;
  assert.equal(responseMsg.statusCode, 201);
  assert.equal(responseMsg.payload?.transactionId, "tx-1");
  assert.equal(responseMsg.payload?.paymentUrl, "https://pay.example/tx-1");
  assert.equal(responseMsg.payload?.operationId, "split-operation-3");
  assert.equal(responseMsg.payload?.gameId, "game-3");
  assert.equal(responseMsg.payload?.settlementState, "PAYMENT_REQUIRED");
});

test("transaction step blocks a payment URL when Viva returns a different amount", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-wrong-amount",
      paymentUrl: "https://pay.example/tx-wrong-amount",
      toPay: 150000,
    },
    _splitCtx: {
      step: "transaction",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      shareAmount: 375,
      shareAmountMinor: 37500,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(out[0], null);
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.details?.code, "SPLIT_PROVIDER_AMOUNT_MISMATCH");
  assert.equal(errorMsg.payload?.details?.expectedAmountMinor, 37500);
  assert.equal(errorMsg.payload?.details?.providerAmountMinor, 150000);
  assert.equal(errorMsg.payload?.paymentUrl, undefined);
});

test("transaction step rejects conflicting provider transaction id aliases", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-expected",
      id: "tx-other",
      paymentUrl: "https://pay.example/tx-other",
      toPay: 37500,
    },
    _splitCtx: {
      step: "transaction",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      shareAmount: 375,
      shareAmountMinor: 37500,
    },
  }) as unknown[];

  const errorMsg = out[1] as RouterMessage;
  assert.equal(out[0], null);
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.details?.code, "SPLIT_PROVIDER_TRANSACTION_ID_INVALID");
  assert.equal(errorMsg.payload?.paymentUrl, undefined);
});

test("transaction step rejects conflicting explicit Viva amount fields", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-conflicting-amount",
      paymentUrl: "https://pay.example/tx-conflicting-amount",
      toPay: 37500,
      toPayMinor: 150000,
    },
    _splitCtx: {
      step: "transaction",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      shareAmount: 375,
      shareAmountMinor: 37500,
    },
  }) as unknown[];

  const lookup = out[0] as RouterRequestMessage;
  assert.equal(lookup.method, "GET");
  assert.match(lookup.url || "", /\/transactions\/tx-conflicting-amount$/);
  assert.equal(lookup._splitCtx.step, "transaction_lookup");
});

test("transaction step reads back the transaction when the direct payment URL has no amount", () => {
  const first = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      transactionId: "tx-readback",
      paymentUrl: "https://pay.example/tx-readback",
    },
    _splitCtx: {
      step: "transaction",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      shareAmount: 375,
      shareAmountMinor: 37500,
    },
  }) as unknown[];

  const lookup = first[0] as RouterRequestMessage;
  assert.equal(lookup.method, "GET");
  assert.match(lookup.url || "", /\/transactions\/tx-readback$/);
  assert.equal(lookup._splitCtx.step, "transaction_lookup");

  const second = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    ...lookup,
    statusCode: 200,
    payload: {
      id: "tx-readback",
      paymentUrl: "https://pay.example/tx-readback",
      toPay: 150000,
    },
  }) as unknown[];

  const errorMsg = second[1] as RouterMessage;
  assert.equal(second[0], null);
  assert.equal(errorMsg.statusCode, 409);
  assert.equal(errorMsg.payload?.details?.code, "SPLIT_PROVIDER_AMOUNT_MISMATCH");
  assert.equal(errorMsg.payload?.details?.expectedAmountMinor, 37500);
  assert.equal(errorMsg.payload?.details?.providerAmountMinor, 150000);
});

test("transaction read-back returns the original URL only for the same id and exact amount", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-readback-exact",
      toPay: 37500,
    },
    _splitCtx: {
      step: "transaction_lookup",
      action: "join",
      paymentMode: "one_time",
      selectedPaymentMode: "one_time",
      transactionId: "tx-readback-exact",
      shareAmount: 375,
      shareAmountMinor: 37500,
      transaction: {
        transactionId: "tx-readback-exact",
        paymentUrl: "https://pay.example/tx-readback-exact",
      },
    },
  }) as unknown[];

  const responseMsg = out[1] as RouterMessage;
  assert.equal(responseMsg.statusCode, 201);
  assert.equal(responseMsg.payload?.transactionId, "tx-readback-exact");
  assert.equal(responseMsg.payload?.paymentUrl, "https://pay.example/tx-readback-exact");
});

test("transaction read-back rejects a wrong or missing transaction id before using its URL", () => {
  for (const payload of [
    {
      id: "tx-other",
      paymentUrl: "https://pay.example/tx-other",
      toPay: 37500,
    },
    {
      paymentUrl: "https://pay.example/missing-id",
      toPay: 37500,
    },
    {
      transactionId: "tx-expected",
      id: "tx-other",
      paymentUrl: "https://pay.example/conflicting-id",
      toPay: 37500,
    },
  ]) {
    const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
      statusCode: 200,
      payload,
      _splitCtx: {
        step: "transaction_lookup",
        action: "join",
        paymentMode: "one_time",
        selectedPaymentMode: "one_time",
        transactionId: "tx-expected",
        shareAmount: 375,
        shareAmountMinor: 37500,
        transaction: {
          transactionId: "tx-expected",
          toPay: 37500,
        },
      },
    }) as unknown[];

    const errorMsg = out[1] as RouterMessage;
    assert.equal(out[0], null);
    assert.equal(errorMsg.statusCode, 409);
    assert.equal(errorMsg.payload?.details?.code, "SPLIT_PROVIDER_TRANSACTION_MISMATCH");
    assert.equal(errorMsg.payload?.details?.expectedTransactionId, "tx-expected");
    assert.equal(errorMsg.payload?.paymentUrl, undefined);
  }
});

test("payment confirmation emits evidence only for a paid transaction bound to the booking and phone", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-confirmed-1",
      status: "PAID",
      client: { id: "client-1", phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-confirmed-1"],
        bookingRequests: [{ exerciseId: "exercise-confirmed-1" }],
      }],
      amountMinor: 250000,
      currency: "RUB",
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-confirmed-1",
      bookingId: "booking-confirmed-1",
      clientId: "client-1",
      expectedExerciseId: "exercise-confirmed-1",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[4]?._verifiedPaymentEvidence?.operationId, "tx-confirmed-1");
  assert.equal(out[4]?._verifiedPaymentEvidence?.bookingId, "booking-confirmed-1");
  assert.equal(out[4]?._verifiedPaymentEvidence?.clientPhoneE164, "+79990000001");
});

test("payment confirmation fails closed for a pending transaction", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-pending-1",
      status: "PAYMENT_PENDING",
      client: { phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-pending-1"],
        bookingRequests: [{ exerciseId: "exercise-pending-1" }],
      }],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-pending-1",
      bookingId: "booking-pending-1",
      clientId: "client-1",
      expectedExerciseId: "exercise-pending-1",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal((out[1]?.payload?.details as Record<string, unknown>)?.code, "LEGACY_PAYMENT_NOT_CONFIRMED");
});

test("subscription confirmation binds the booking to the expected exercise and client", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-subscription-1",
      isCancelled: false,
      cancelled: false,
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-subscription-1",
      count: 1,
      client: { id: "client-1", phone: "+79990000001" },
      exercise: { id: "exercise-1" },
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-subscription-1",
      bookingId: "booking-subscription-1",
      clientId: "client-1",
      expectedExerciseId: "exercise-1",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[4]?._verifiedPaymentEvidence?.operationType, "SUBSCRIPTION_BOOKING");
  assert.equal(out[4]?._verifiedPaymentEvidence?.clientPhoneE164, "+79990000001");
  assert.equal(out[4]?._verifiedPaymentEvidence?.clientSubscriptionId, "client-subscription-1");
  assert.equal(out[4]?._verifiedPaymentEvidence?.subscriptionVisitCount, 1);
});

test("subscription confirmation uses the server-stored duration count when Viva omits count", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-subscription-2",
      isCancelled: false,
      cancelled: false,
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-subscription-2",
      client: { id: "client-2", phone: "+79990000002" },
      exercise: { id: "exercise-2" },
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-subscription-2",
      bookingId: "booking-subscription-2",
      clientId: "client-2",
      expectedExerciseId: "exercise-2",
      expectedSubscriptionVisitCount: 2,
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[4]?._verifiedPaymentEvidence?.clientSubscriptionId, "client-subscription-2");
  assert.equal(out[4]?._verifiedPaymentEvidence?.subscriptionVisitCount, 2);
});

test("subscription confirmation never treats a catalog subscriptionId as a client instance", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-catalog-only",
      isCancelled: false,
      cancelled: false,
      paymentType: "SUBSCRIPTION",
      subscriptionId: "catalog-product-id",
      count: 1,
      client: { id: "client-1", phone: "+79990000001" },
      exercise: { id: "exercise-1" },
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-catalog-only",
      bookingId: "booking-catalog-only",
      clientId: "client-1",
      expectedExerciseId: "exercise-1",
      expectedSubscriptionVisitCount: 1,
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[4], undefined);
  assert.equal(out[1]?.statusCode, 409);
  assert.equal(
    (out[1]?.payload?.details as Record<string, unknown>)?.code,
    "LEGACY_SUBSCRIPTION_BOOKING_NOT_CONFIRMED",
  );
});

test("payment confirmation rejects a paid transaction bound to another exercise", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-wrong-exercise",
      status: "PAID",
      client: { phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-wrong-exercise"],
        bookingRequests: [{ exerciseId: "exercise-other" }],
      }],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-wrong-exercise",
      bookingId: "booking-wrong-exercise",
      clientId: "client-1",
      expectedExerciseId: "exercise-expected",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal((out[1]?.payload?.details as Record<string, unknown>)?.code, "LEGACY_PAYMENT_NOT_CONFIRMED");
});

test("payment confirmation rejects non-canonical success-like statuses", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "tx-success-like",
      status: "SUCCESS",
      client: { phone: "+79990000001" },
      products: [{
        bookingIds: ["booking-success-like"],
        bookingRequests: [{ exerciseId: "exercise-success-like" }],
      }],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-success-like",
      bookingId: "booking-success-like",
      clientId: "client-1",
      expectedExerciseId: "exercise-success-like",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
});

test("subscription confirmation requires explicit active non-cancelled fields", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      id: "booking-subscription-implicit",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-subscription-implicit",
      client: { id: "client-1", phone: "+79990000001" },
      exercise: { id: "exercise-implicit" },
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-subscription-implicit",
      bookingId: "booking-subscription-implicit",
      clientId: "client-1",
      expectedExerciseId: "exercise-implicit",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal(
    (out[1]?.payload?.details as Record<string, unknown>)?.code,
    "LEGACY_SUBSCRIPTION_BOOKING_NOT_CONFIRMED",
  );
});

test("payment confirmation rejects fields mixed from sibling provider records", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      items: [
        {
          id: "tx-mix-match",
          status: "PAID",
          client: { phone: "+79990000001" },
          products: [{ bookingIds: ["booking-other"] }],
        },
        {
          id: "unrelated-record",
          products: [{
            bookingIds: ["booking-expected"],
            bookingRequests: [{ exerciseId: "exercise-expected" }],
          }],
        },
      ],
    },
    _splitCtx: {
      step: "confirm_transaction_lookup",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "tx-mix-match",
      bookingId: "booking-expected",
      clientId: "client-1",
      expectedExerciseId: "exercise-expected",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
});

test("subscription confirmation requires exercise, client and phone on the exact booking", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_router.js", {
    statusCode: 200,
    payload: {
      items: [
        {
          id: "booking-exact",
          isCancelled: false,
          cancelled: false,
          paymentType: "SUBSCRIPTION",
          clientSubscriptionId: "subscription-1",
        },
        {
          id: "booking-sibling",
          client: { id: "client-1", phone: "+79990000001" },
          exercise: { id: "exercise-1" },
        },
      ],
    },
    _splitCtx: {
      step: "confirm_subscription_booking_lookup",
      action: "confirm_payment",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-exact",
      bookingId: "booking-exact",
      clientId: "client-1",
      expectedExerciseId: "exercise-1",
    },
  }) as Array<RouterMessage | null>;

  assert.equal(out[1]?.statusCode, 409);
  assert.equal(
    (out[1]?.payload?.details as Record<string, unknown>)?.code,
    "LEGACY_SUBSCRIPTION_BOOKING_NOT_CONFIRMED",
  );
});

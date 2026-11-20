const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const reply = (status, body) => {
  msg.statusCode = status;
  msg.payload = body;
  msg.headers = responseHeaders;
  return [null, msg];
};

const request = msg.tournamentPaymentReconciliation;
if (!request) {
  const exerciseId = msg.req?.query?.exerciseId;
  const auth = msg.req?.headers?.authorization;
  if (typeof exerciseId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exerciseId)) {
    return reply(400, { code: "EXERCISE_ID_INVALID" });
  }
  if (typeof auth !== "string" || auth.length > 8192 || !/^Bearer [a-z0-9._~+\/=-]+$/i.test(auth)) {
    return reply(401, { code: "TOURNAMENT_AUTH_REQUIRED" });
  }

  let url;
  try {
    const base = new cupUrl.URL(env.get("CUP_API_BASE_URL"));
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash
      || (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))) {
      return reply(503, { code: "TOURNAMENT_RECONCILIATION_UNAVAILABLE" });
    }
    url = base.origin + base.pathname.replace(/\/+$/, "")
      + "/tournaments/" + encodeURIComponent(exerciseId) + "/checkout/reconcile";
  } catch {
    return reply(503, { code: "TOURNAMENT_RECONCILIATION_UNAVAILABLE" });
  }

  msg.tournamentPaymentReconciliation = { exerciseId, url };
  msg.url = url;
  msg.method = "POST";
  msg.followRedirects = false;
  msg.requestTimeout = 35_000;
  msg.headers = { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" };
  msg.payload = {};
  return [msg, null];
}

delete msg.tournamentPaymentReconciliation;
const status = Number(msg.statusCode);
if (msg.error || msg.responseUrl !== request.url || msg.url !== request.url
  || msg.method !== "POST" || msg.followRedirects !== false || status < 200 || status >= 600
  || (status >= 300 && status < 400) || !Number.isInteger(status)) {
  return reply(502, { code: "TOURNAMENT_RECONCILIATION_UNAVAILABLE" });
}

const receipt = msg.payload;
if (status >= 400) {
  const code = typeof receipt?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(receipt.code)
    ? receipt.code : "TOURNAMENT_RECONCILIATION_FAILED";
  return reply(status, { code });
}
const isReceiptId = (value) => typeof value === "string" && /^[a-z0-9._:-]{1,200}$/i.test(value);
if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
  return reply(502, { code: "TOURNAMENT_RECONCILIATION_UNAVAILABLE" });
}

if (receipt.state === "COMPLETED") {
  if (!isReceiptId(receipt.bookingId) || !isReceiptId(receipt.transactionId)
    || !isReceiptId(receipt.requestOperationId)) {
    return reply(502, { code: "TOURNAMENT_RECONCILIATION_UNAVAILABLE" });
  }
  const now = Date.now();
  const seenKey = "lkTournamentParticipantReconciledPaymentsV1";
  const seen = flow.get(seenKey) || {};
  const payment = JSON.stringify([request.exerciseId, receipt.transactionId, receipt.bookingId]);
  // Keep the receipt through the maximum stale-cache lifetime to coalesce retries.
  for (const [key, at] of Object.entries(seen)) {
    if (now - at >= 10 * 60_000) delete seen[key];
  }
  if (!Object.hasOwn(seen, payment)) {
    const keys = Object.keys(seen);
    if (keys.length >= 2_000) delete seen[keys[0]];
    seen[payment] = now;
    flow.set(seenKey, seen);

    const epochKey = "lkTournamentParticipantEpochV1";
    const epochs = global.get(epochKey) || {};
    epochs[request.exerciseId] = Math.max(0, Number(epochs[request.exerciseId]) || 0) + 1;
    global.set(epochKey, epochs);
  }
  const { state, bookingId, transactionId, requestOperationId } = receipt;
  return reply(status, { state, bookingId, transactionId, requestOperationId });
}
return reply(status, Object.fromEntries(
  ["state", "operationId", "transactionId"].filter((key) => isReceiptId(receipt[key])).map((key) => [key, receipt[key]]),
));

import fs from "node:fs";

const read = name => fs.readFileSync(new URL("../nodered_tournament_checkout_nodes/" + name, import.meta.url), "utf8");
const cupAdmission = () => read("cup_admission.js");
const enrollment = () => read("enrollment_claim.js");
export const tournamentCheckoutSource = () => cupAdmission() + "\n" + enrollment() + "\n" + read("checkout.js");

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error("Tournament subscription gateway anchor drift: " + anchor);
  return source.replace(anchor, () => replacement);
}

export function patchTournamentSubscriptionGateway(source) {
  if (source.includes("const CUP_TOURNAMENT_API")) throw new Error("Tournament level gate already installed");
  source = replaceOnce(source, "const emit = (index, value = msg) => {", `
${cupAdmission()}
${enrollment()}
${read("subscription_gate.js")}
const emit = (index, value = msg) => {
  const tournamentCtx = value._subscriptionBooking;
  if (index === OUTPUT_HTTP && tournamentCtx?.step === "booking_create" && isTournamentSubscriptionWrite(tournamentCtx)) {
    if (!tournamentCtx.tournamentDispatchPermit) {
      return claimTournamentDispatch(tournamentCtx, {
        url: value.url, method: value.method, payload: value.payload, headers: value.headers });
    }
    delete tournamentCtx.tournamentDispatchPermit;
    tournamentCtx.tournamentBookingSent = { url: value.url };
  }
  if (index === OUTPUT_MONGO_INSERT && tournamentCtx?.step !== "tournament_enrollment"
    && tournamentCtx && isTournamentSubscriptionWrite(tournamentCtx)) {
    if (!hasCupTournamentAdmission(tournamentCtx)) {
      return beginCupTournamentGate(tournamentCtx, { type: "insert", step: tournamentCtx.step, payload: value.payload });
    }
    const reservation = reserveTournamentSubscription(tournamentCtx, { type: "insert",
      step: tournamentCtx.step, payload: value.payload });
    if (reservation) return reservation;
    const record = Array.isArray(value.payload) ? value.payload[0] : value.payload;
    record.cupTournamentAdmission = tournamentCtx.cupTournamentAdmission;
  }`.trimStart());

  // The latest composed source may put other guards in these functions. Insert before all
  // of them, especially acquisition of the separate daily visit claim.
  source = replaceOnce(source, "const preparePreaccept = (ctx) => {", `
const preparePreaccept = (ctx) => {
  if (isTournamentSubscriptionWrite(ctx)) {
    if (!hasCupTournamentAdmission(ctx)) return beginCupTournamentGate(ctx, { type: "preaccept" });
    const reservation = reserveTournamentSubscription(ctx, { type: "preaccept" });
    if (reservation) return reservation;
    if (Date.parse(ctx.tournamentBookingClaim.reservedUntil) <= Date.now()) return postponeTournamentSubscription(ctx);
  }`.trimStart());

  source = replaceOnce(source, "const prepareBookingCreate = (ctx) => {", `
const prepareBookingCreate = (ctx) => {
  if (isTournamentSubscriptionWrite(ctx) && !hasCupTournamentAdmission(ctx)) {
    return postponeTournamentSubscription(ctx);
  }`.trimStart());

  const dispatch = `
if (ctx.step === "cup_tournament_admission") {
  const continuation = ctx.cupTournamentContinuation;
  delete ctx.cupTournamentContinuation;
  const decision = readCupTournamentDecision(msg, ctx.actorClientId, ctx.exerciseId);
  if (!decision.admission) {
    return finishError(ctx, decision.status, decision.message, { code: decision.code });
  }
  ctx.cupTournamentAdmission = decision.admission;
  return continueTournamentSubscription(ctx, continuation);
}
if (ctx.step === "tournament_enrollment") {
  return subscriptionEnrollmentEffect(ctx, teStep(ctx.tournamentEnrollmentStep, msg));
}
if (ctx.step === "tournament_enrollment_dispatch") {
  if (msg.error || !teMatch(msg.payload) || !ctx.tournamentBookingClaim) {
    const ack = msg.payload;
    const noDispatch = !msg.error && ack?.acknowledged === true && ack.matchedCount === 0
      && ack.modifiedCount === 0 && ack.upsertedCount === 0 && ack.upsertedId === null;
    if (noDispatch && !ctx.managedEntitlementOperationId && ctx.tournamentPreaccepted === true) {
      return prepareFailedUpdate(ctx, 409, "Резерв записи истёк. Обновите варианты и запишитесь снова.",
        "TOURNAMENT_ENROLLMENT_RESERVATION_EXPIRED");
    }
    return postponeTournamentSubscription(ctx);
  }
  ctx.tournamentBookingClaim.state = "HELD";
  return prepareMongoUpdate(ctx, "tournament_enrollment_bound", tournamentOwnPreaccept(ctx), {
    $set: { tournamentEnrollment: { generation: ctx.tournamentBookingClaim.generation, attemptedAt: ctx.tournamentPreacceptAt } },
  });
}
if (ctx.step === "tournament_enrollment_bound") {
  if (msg.error || !teMatch(msg.payload) || !ctx.tournamentBookingClaim || ctx.tournamentBookingRequest?.method !== "POST") {
    return postponeTournamentSubscription(ctx);
  }
  const request = ctx.tournamentBookingRequest;
  delete ctx.tournamentBookingRequest;
  ctx.tournamentDispatchPermit = true;
  const output = prepareHttp(ctx, "booking_create", request.method, request.url, request.payload, request.headers);
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  delete msg.responseUrl;
  delete msg.statusCode;
  return output;
}

`;

  // Reclaim is itself a reservation write. Preserve replay paths (including CONFIRMED)
  // by fencing only the branch that actually moves the operation to PREPARED.
  const emitUpdate = '  if (index === OUTPUT_MONGO_INSERT && tournamentCtx?.step !== "tournament_enrollment"';
  source = replaceOnce(source, emitUpdate, `
  if (index === OUTPUT_MONGO_UPDATE && tournamentCtx
    && (isTournamentSubscriptionWrite(tournamentCtx) || value.payload?.[0]?.category === "tournament")) {
    if (["operation_reclaim", "lk1_ingress_reclaim", "lk1_daily_visit_retry_saved"].includes(tournamentCtx.step)) {
      const continuation = { type: "reclaim", step: tournamentCtx.step, payload: value.payload };
      if (!hasCupTournamentAdmission(tournamentCtx)) return beginCupTournamentGate(tournamentCtx, continuation);
      const reservation = reserveTournamentSubscription(tournamentCtx, continuation);
      if (reservation) return reservation;
    }
    if (["tournament_enrollment_bound", "tournament_enrollment_dispatch"].includes(tournamentCtx.step)) {
      value.payload[2] = teWrite;
    }
    if (tournamentCtx.step === "operation_preaccept" && hasCupTournamentAdmission(tournamentCtx)) {
      value.payload[2] = teWrite;
      const update = value.payload[1];
      update.$set.upstreamAttemptedAt = tournamentCtx.tournamentPreacceptAt;
      update.$set.cupTournamentAdmission = tournamentCtx.cupTournamentAdmission;
      update.$unset = { ...update.$unset, tournamentEnrollment: "", tournamentRejection: "" };
    }
    if (tournamentCtx.step === "operation_fail" && tournamentCtx.tournamentBookingClaim
      && tournamentCtx.tournamentPreaccepted === true) {
      const [query, update] = value.payload;
      Object.assign(query, tournamentOwnPreaccept(tournamentCtx), tournamentCtx.tournamentBookingSent
        ? { "tournamentEnrollment.generation": tournamentCtx.tournamentBookingClaim.generation }
        : { tournamentEnrollment: { $exists: false } });
      if (tournamentCtx.tournamentBookingSent
        && tournamentCtx.tournamentBookingRefusal === update.$set.failure?.statusCode) {
        update.$set.tournamentRejection = { generation: tournamentCtx.tournamentBookingClaim.generation,
          status: tournamentCtx.tournamentBookingRefusal, entitlementReleased: tournamentCtx.managedEntitlementReleased === true };
      }
      value.payload[2] = teWrite;
    }
  }
` + emitUpdate);

  const ingress = '        state: operation.state, bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] },';
  if (!source.includes(ingress)) throw new Error("LK1 ingress reclaim anchor drift");
  source = replaceOnce(source, ingress, ingress + '\n        category: operation.category, exerciseId: operation.exerciseId,');
  const preacceptAck = 'if (ctx.step === "operation_preaccept") {';
  source = replaceOnce(source, preacceptAck, preacceptAck + `
  if (isTournamentSubscriptionWrite(ctx)) {
    if (msg.error || !teMatch(msg.payload) || !teDate(ctx.tournamentPreacceptAt)) return postponeTournamentSubscription(ctx);
    ctx.tournamentPreaccepted = true;
  }`);
  const failedAck = 'if (ctx.step === "operation_fail") {';
  source = replaceOnce(source, failedAck, failedAck + `
  if (isTournamentSubscriptionWrite(ctx) && ctx.tournamentPreaccepted === true
    && (msg.error || !teMatch(msg.payload))) return postponeTournamentSubscription(ctx);`);
  const providerAck = 'if (ctx.step === "booking_create") {';
  source = replaceOnce(source, providerAck, providerAck + '\n  markTournamentBookingRefusal(ctx);');
  const profile = 'if (ctx.step === "profile") {';
  return replaceOnce(source, profile, dispatch + "\n" + profile);
}

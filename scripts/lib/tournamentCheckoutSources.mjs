import fs from "node:fs";

const read = name => fs.readFileSync(new URL("../nodered_tournament_checkout_nodes/" + name, import.meta.url), "utf8");
const cupAdmission = () => read("cup_admission.js");
export const tournamentCheckoutSource = () => cupAdmission() + "\n" + read("checkout.js");

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error("Tournament subscription gateway anchor drift: " + anchor);
  return source.replace(anchor, () => replacement);
}

export function patchTournamentSubscriptionGateway(source) {
  if (source.includes("const CUP_TOURNAMENT_API")) throw new Error("Tournament level gate already installed");
  source = replaceOnce(source, "const emit = (index, value = msg) => {", `
${cupAdmission()}
${read("subscription_gate.js")}
const emit = (index, value = msg) => {
  const tournamentCtx = value._subscriptionBooking;
  if (index === OUTPUT_MONGO_INSERT && tournamentCtx && isTournamentSubscriptionWrite(tournamentCtx)) {
    if (!hasCupTournamentAdmission(tournamentCtx)) {
      return beginCupTournamentGate(tournamentCtx, { type: "insert", step: tournamentCtx.step, payload: value.payload });
    }
    const record = Array.isArray(value.payload) ? value.payload[0] : value.payload;
    record.cupTournamentAdmission = tournamentCtx.cupTournamentAdmission;
  }`.trimStart());

  // The latest composed source may put other guards in these functions. Insert before all
  // of them, especially acquisition of the separate daily visit claim.
  source = replaceOnce(source, "const preparePreaccept = (ctx) => {", `
const preparePreaccept = (ctx) => {
  if (isTournamentSubscriptionWrite(ctx) && !hasCupTournamentAdmission(ctx)) {
    return beginCupTournamentGate(ctx, { type: "preaccept" });
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
  if (continuation?.type === "insert") {
    ctx.step = continuation.step;
    msg.payload = continuation.payload;
    return emit(OUTPUT_MONGO_INSERT);
  }
  if (continuation?.type === "preaccept") return preparePreaccept(ctx);
  if (continuation?.type === "reclaim") {
    ctx.step = continuation.step;
    msg.payload = continuation.payload;
    return emit(OUTPUT_MONGO_UPDATE);
  }
  return postponeTournamentSubscription(ctx);
}
`;

  // Reclaim is itself a reservation write. Preserve replay paths (including CONFIRMED)
  // by fencing only the branch that actually moves the operation to PREPARED.
  const emitUpdate = "  if (index === OUTPUT_MONGO_INSERT && tournamentCtx && isTournamentSubscriptionWrite(tournamentCtx)) {";
  source = replaceOnce(source, emitUpdate, `
  if (index === OUTPUT_MONGO_UPDATE && tournamentCtx
    && (isTournamentSubscriptionWrite(tournamentCtx) || value.payload?.[0]?.category === "tournament")) {
    if (["operation_reclaim", "lk1_ingress_reclaim", "lk1_daily_visit_retry_saved"].includes(tournamentCtx.step)
      && !hasCupTournamentAdmission(tournamentCtx)) {
      return beginCupTournamentGate(tournamentCtx, { type: "reclaim", step: tournamentCtx.step, payload: value.payload });
    }
    if (tournamentCtx.step === "operation_preaccept" && hasCupTournamentAdmission(tournamentCtx)) {
      value.payload[1].$set.cupTournamentAdmission = tournamentCtx.cupTournamentAdmission;
    }
  }
` + emitUpdate);

  const ingress = '        state: operation.state, bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] },';
  if (!source.includes(ingress)) throw new Error("LK1 ingress reclaim anchor drift");
  source = replaceOnce(source, ingress, ingress + '\n        category: operation.category, exerciseId: operation.exerciseId,');
  const profile = 'if (ctx.step === "profile") {';
  return replaceOnce(source, profile, dispatch + "\n" + profile);
}

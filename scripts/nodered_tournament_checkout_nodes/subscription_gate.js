const isTournamentSubscriptionWrite = (ctx) => ctx.category === "tournament"
  || ctx.managedAction === "BOOK_TOURNAMENT" || ctx.lk1?.target?.category === "TOURNAMENT";

const hasCupTournamentAdmission = (ctx) => ctx.cupTournamentAdmission?.actor === ctx.actorClientId
  && ctx.cupTournamentAdmission?.exercise === ctx.exerciseId && Boolean(ctx.cupTournamentAdmission?.ruleVersion);

const beginCupTournamentGate = (ctx, continuation) => {
  ctx.cupTournamentContinuation = continuation;
  const output = prepareHttp(ctx, "cup_tournament_admission", "GET", cupTournamentDecisionUrl(ctx.exerciseId),
    undefined, { Authorization: ctx.authHeader, Accept: "application/json" });
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  delete msg.responseUrl;
  delete msg.statusCode;
  return output;
};

const postponeTournamentSubscription = (ctx) => finishPending(ctx,
  "Запись на турнир требует сверки допуска.", { code: "TOURNAMENT_LEVEL_ADMISSION_RECONCILIATION_REQUIRED" });

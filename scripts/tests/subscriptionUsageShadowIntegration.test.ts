import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gamesSource = readFileSync(
  new URL("../../src/components/games/GamesPage.tsx", import.meta.url),
  "utf8",
);
const joinSource = readFileSync(
  new URL("../../src/components/games/GameJoinPage.tsx", import.meta.url),
  "utf8",
);
const findSource = readFileSync(
  new URL("../../src/components/games/FindGamePage.tsx", import.meta.url),
  "utf8",
);
const cabinetSource = readFileSync(
  new URL("../../src/components/cabinet/Cabinet.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../src/MyApp.tsx", import.meta.url),
  "utf8",
);
const shadowHarnessSource = readFileSync(
  new URL("../../src/subscription-shadow-dev.tsx", import.meta.url),
  "utf8",
);
const shadowHarnessHtml = readFileSync(
  new URL("../../subscription-shadow-dev.html", import.meta.url),
  "utf8",
);
const groupScheduleSource = readFileSync(
  new URL("../../src/components/group-schedule/GroupSchedulePage.tsx", import.meta.url),
  "utf8",
);
const tournamentSignupSource = readFileSync(
  new URL("../../src/components/tournament-signup/TournamentSignupPage.tsx", import.meta.url),
  "utf8",
);

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertGuardBefore(block: string, guardedCall: string): void {
  const guardIndex = block.indexOf("if (subscriptionUsageShadowEnabled)");
  const callIndex = block.indexOf(guardedCall);
  assert.notEqual(guardIndex, -1, "missing DEV-shadow guard");
  assert.notEqual(callIndex, -1, `missing guarded call: ${guardedCall}`);
  assert.ok(guardIndex < callIndex, `DEV-shadow guard must precede ${guardedCall}`);
}

test("create payment paths stop at DEV-shadow before Viva, payment, or game-record writes", () => {
  const splitPayment = sliceBetween(
    gamesSource,
    "const handleSplitGamePay = useCallback",
    "const handleMasterServicePay = useCallback",
  );
  assertGuardBefore(splitPayment, "apiCreatePadelSplitGamePayment");

  const masterPayment = sliceBetween(
    gamesSource,
    "const handleMasterServicePay = useCallback",
    "const handleA3PayDevVivaBookingCreate = useCallback",
  );
  assertGuardBefore(masterPayment, "apiPayMasterService");

  const finalCreate = sliceBetween(
    gamesSource,
    "const handleCreateGame = () =>",
    "const handleCopyInvite = async",
  );
  assertGuardBefore(finalCreate, "handleCreateGameFromBooking");
  assert.match(gamesSource, /IS_DEV_RELEASE_CHANNEL && !subscriptionUsageShadowEnabled/);
});

test("payment callback recovery is inert while ordinary lk_dev shadow mode is active", () => {
  const recoveryMarker = "const paymentRef = url.searchParams.get(PAYMENT_REF_QUERY_KEY)";
  const recoveryIndex = gamesSource.indexOf(recoveryMarker);
  assert.notEqual(recoveryIndex, -1);
  const effectStart = gamesSource.lastIndexOf("useEffect(() => {", recoveryIndex);
  const recoveryBlock = gamesSource.slice(effectStart, recoveryIndex + recoveryMarker.length);
  assert.match(recoveryBlock, /if \(subscriptionUsageShadowEnabled\) return;/);
});

test("join path and automatic roster reconciliation cannot write in DEV-shadow", () => {
  const joinDecision = sliceBetween(
    joinSource,
    "const applyDecision = useCallback",
    "if (loading)",
  );
  assertGuardBefore(joinDecision, "apiFetchPadelGameRecord(game.id)");
  assert.match(joinDecision, /target === "decline"[\s\S]*DEV-shadow не изменяет реальные записи/);

  const rosterCallIndex = joinSource.indexOf("apiFetchTournamentParticipants(exerciseId");
  assert.notEqual(rosterCallIndex, -1);
  const rosterEffectStart = joinSource.lastIndexOf("useEffect(() => {", rosterCallIndex);
  const rosterBlock = joinSource.slice(rosterEffectStart, rosterCallIndex);
  assert.match(rosterBlock, /if \(subscriptionUsageShadowEnabled\) return;/);
});

test("the shipped games bundle guards details join, split payment, and background repairs", () => {
  const splitJoin = sliceBetween(
    gamesSource,
    "const handleSplitJoinCurrentUserFromDetails = useCallback",
    "const handleJoinCurrentUserFromDetails = useCallback",
  );
  assertGuardBefore(splitJoin, "apiCommandPadelGameRoster");
  assertGuardBefore(splitJoin, "apiCreatePadelSplitParticipantPayment");

  const ordinaryJoin = sliceBetween(
    gamesSource,
    "const handleJoinCurrentUserFromDetails = useCallback",
    "const handleOpenCabinetFromDetails = useCallback",
  );
  assertGuardBefore(ordinaryJoin, "apiCommandPadelGameRoster");

  for (const marker of [
    "apiCleanupPadelGameByOrganizer(activeGameRecord.id",
    "apiFetchTournamentParticipants(exerciseId",
    "apiUpdatePadelGameRecord(activeGameRecord.id",
  ]) {
    const callIndex = gamesSource.indexOf(marker, gamesSource.indexOf("const detailsSplitSubscriptionOptions"));
    assert.notEqual(callIndex, -1, `missing guarded details marker: ${marker}`);
    const effectStart = gamesSource.lastIndexOf("useEffect(() => {", callIndex);
    const effectBlock = gamesSource.slice(effectStart, callIndex);
    assert.match(effectBlock, /if \(subscriptionUsageShadowEnabled\) return;/);
  }
  assert.match(gamesSource, /Проверить присоединение без записи/);
});

test("ordinary lk_dev navigation sends event checks to an isolated DEV-only harness", () => {
  assert.match(cabinetSource, /appendSubscriptionUsageShadowToSameOriginUrl\(parsed, current\)/);
  assert.match(findSource, /appendCurrentSubscriptionUsageShadow\(url\)/);
  assert.match(findSource, /url\.searchParams\.set\("channel", "dev"\)/);
  assert.match(findSource, /appendCurrentSubscriptionUsageShadow\(target\)/);
  assert.match(cabinetSource, /new URL\("\/subscription-shadow-dev\.html", current\.origin\)/);
  assert.match(cabinetSource, /parsed\.searchParams\.set\("screen", "group"\)/);
  assert.match(cabinetSource, /parsed\.searchParams\.set\("screen", "tournament"\)/);
  assert.match(cabinetSource, /resolveTournamentSignupHref\(action\.href\)/);
  assert.match(shadowHarnessHtml, /src="\/src\/subscription-shadow-dev\.tsx"/);
  assert.match(shadowHarnessSource, /if \(!import\.meta\.env\.DEV\)/);
  assert.match(shadowHarnessSource, /<GroupSchedulePage/);
  assert.match(shadowHarnessSource, /<TournamentSignupPage/);
  assert.doesNotMatch(appSource, /subscription-shadow-dev|GroupSchedulePage|TournamentSignupPage/);
});

test("group training DEV-shadow checks the exact event before every Viva mutation path", () => {
  const registration = sliceBetween(
    groupScheduleSource,
    "const completeRegistration = useCallback",
    "const openCancelDialog = useCallback",
  );
  assertGuardBefore(registration, "apiCreateTournamentVivaTransaction");
  assert.match(groupScheduleSource, /action: "BOOK_GROUP_TRAINING"/);
  assert.match(groupScheduleSource, /targetKind: "EVENT_AGGREGATE"/);
  assert.match(groupScheduleSource, /Проверить скидку 50% без записи и оплаты/);
  assert.match(groupScheduleSource, /if \(subscriptionUsageShadowEnabled\)[\s\S]*DEV-shadow не изменяет существующие записи/);
});

test("tournament DEV-shadow replaces checkout actions and stops automatic payment continuation", () => {
  const registration = sliceBetween(
    tournamentSignupSource,
    "const completeVivaRegistration = useCallback",
    "const loadCheckout = useCallback",
  );
  assertGuardBefore(registration, "apiCreateTournamentVivaTransaction");
  assert.match(tournamentSignupSource, /action: "BOOK_TOURNAMENT"/);
  assert.match(tournamentSignupSource, /targetKind: "EVENT_AGGREGATE"/);
  assert.match(tournamentSignupSource, /Проверить скидку 50% без записи и оплаты/);
  assert.match(
    tournamentSignupSource,
    /if \(subscriptionUsageShadowEnabled\) return;[\s\S]*pendingPaymentProduct/,
  );
  assert.match(
    tournamentSignupSource,
    /loadList\(\{ requestRefresh: !subscriptionUsageShadowEnabled \}\)/,
  );
  assert.match(
    tournamentSignupSource,
    /if \(subscriptionUsageShadowEnabled\) \{[\s\S]*setLiveRatings\(new Map\(\)\)/,
  );
});

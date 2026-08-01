import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const bookingCardSource = fs.readFileSync("src/components/cabinet/BookingCard.tsx", "utf8");
const bookingDialogSource = fs.readFileSync(
  "src/components/cabinet/BookingCancellationDialog.tsx",
  "utf8",
);
const bookingsContainerSource = fs.readFileSync(
  "src/components/cabinet/BookingsContainer.tsx",
  "utf8",
);
const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const gameJoinSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

function sourceSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("self leave helper uses bearer auth and sends no client-controlled authority", () => {
  const helperSource = sourceSlice(
    apiClientSource,
    "export async function apiLeavePadelGameAsCurrentUser",
    "export async function apiCleanupPadelGameByOrganizer",
  );
  const wireBody = sourceSlice(
    helperSource,
    "body: JSON.stringify({",
    "}),",
  );

  assert.match(helperSource, /\/lk\/games\/\$\{encodeURIComponent\(normalizedGameId\)\}\/split\/leave/);
  assert.match(helperSource, /auth:\s*true/);
  assert.match(wireBody, /reason:\s*"PLAYER_LEFT"/);
  assert.match(wireBody, /refundMethod/);
  assert.doesNotMatch(wireBody, /operationId|bookingIds|clientId|playerPhone|exerciseId/);
});

test("all game chat helpers attach bearer auth", () => {
  const helpers = [
    ["apiFetchPadelGameChatMessages", "apiSendPadelGameChatMessage"],
    ["apiSendPadelGameChatMessage", "apiMarkPadelGameChatRead"],
    ["apiMarkPadelGameChatRead", "apiFetchPadelChatsByPhone"],
    ["apiFetchPadelChatsByPhone", "trimTrailingSlashes"],
  ] as const;

  helpers.forEach(([start, end]) => {
    const helperSource = sourceSlice(
      apiClientSource,
      `export async function ${start}`,
      end === "trimTrailingSlashes"
        ? "function trimTrailingSlashes"
        : `export async function ${end}`,
    );
    assert.match(helperSource, /auth:\s*true/, `${start} must use bearer auth`);
  });
});

test("generic BookingCard routes only an exact active linked game to server leave", () => {
  assert.match(bookingCardSource, /executeAction=\{async \(action\)/);
  assert.match(bookingCardSource, /if \(executeCancellation\) return executeCancellation\(action\)/);
  assert.match(bookingCardSource, /apiLeavePadelGameAsCurrentUser\(linkedGameId,\s*\{\s*refundMethod:\s*action\.refundMethod/);
  assert.doesNotMatch(bookingCardSource, /executeAction=\{undefined\}/);
  assert.match(bookingCardSource, /if \(linkedGameAmbiguous \|\| !linkedGameId\)/);
  assert.match(bookingCardSource, /Отмена остановлена/);
  assert.match(bookingDialogSource, /await defaultExecuteAction\(bookingId, action\)/);

  const resolverSource = sourceSlice(
    bookingsContainerSource,
    "function resolveActiveLinkedGameId",
    "function buildGamesAwareItems",
  );
  assert.match(resolverSource, /resolveGameForBooking\?\.\(booking\)/);
  assert.match(resolverSource, /linkedGame\.archived === true/);
  assert.match(resolverSource, /isCancelledGameRecord\(linkedGame\)/);
  assert.doesNotMatch(resolverSource, /game\.id === linkedGame\.id/);
  assert.match(cabinetSource, /buildUniqueGameLookup/);
  assert.match(cabinetSource, /if \(byId\.matched\) return byId\.value/);
  assert.match(cabinetSource, /apiFetchPadelGamesByBookingReferences/);
  assert.match(cabinetSource, /exactState\?\.state !== "unique"/);
  assert.match(cabinetSource, /resolveCancellationGameLink=\{resolveCancellationGameLink\}/);
  assert.match(cabinetSource, /executeBookingCancellation=\{executeBookingCancellation\}/);
});

test("booking cancellation waits for a complete exact multi-record lookup", () => {
  const exactLookupSource = sourceSlice(
    apiClientSource,
    "export async function apiFetchPadelGamesByBookingReferences",
    "export async function apiFetchPadelGameByPaymentRef",
  );
  assert.match(exactLookupSource, /limit = 500/);
  assert.match(exactLookupSource, /extractPadelGameRecordList\(response\.data\)/);
  assert.match(exactLookupSource, /endpointTotal > records\.length/);
  assert.match(exactLookupSource, /complete,/);
  assert.doesNotMatch(exactLookupSource, /\[0\]/);
  assert.match(cabinetSource, /result\.value\.data\?\.complete/);
  assert.match(cabinetSource, /exactActiveCandidates\.length === 1/);
  assert.match(cabinetSource, /state: "ambiguous"/);
});

test("every booking cancellation rechecks exact linkage at the mutation boundary", () => {
  const executorSource = sourceSlice(
    cabinetSource,
    "const executeBookingCancellation = useCallback",
    "const resolveCancelledGameForBooking",
  );
  assert.match(executorSource, /apiFetchPadelGamesByBookingReferences\(paymentRefs, \[bookingId\]\)/);
  assert.match(executorSource, /!exactResult\.data\?\.complete/);
  assert.match(executorSource, /activeLinkedGames\.length > 1/);
  assert.match(executorSource, /apiLeavePadelGameAsCurrentUser\(activeLinkedGames\[0\]\.id/);
  const gameLikeGuard = executorSource.indexOf("isExerciseConvertibleToGameFromBooking(booking)");
  const directVivaCancel = executorSource.indexOf("apiCancelBooking(bookingId, action)");
  assert.ok(gameLikeGuard >= 0 && directVivaCancel > gameLikeGuard);
});

test("organizer game cancellation never falls back to direct Viva cancellation", () => {
  const organizerCancelSource = sourceSlice(
    cabinetSource,
    "const handleCancelGameBooking = async",
    "const handleArchiveGameFromCabinet = async",
  );
  assert.match(organizerCancelSource, /apiCleanupPadelGameByOrganizer\(gameId/);
  assert.match(organizerCancelSource, /cleanupItem\?\.cancelledInLk === true/);
  assert.doesNotMatch(organizerCancelSource, /apiCancelBooking/);
  assert.doesNotMatch(organizerCancelSource, /cleanupItems\[0\]/);
});

test("linked cancellation distinguishes DONE, pending and terminal errors", () => {
  assert.match(bookingCardSource, /state === "RETRY_REQUIRED"/);
  assert.match(bookingCardSource, /state === "IN_PROGRESS"/);
  assert.match(bookingCardSource, /Бронирование отменено, обновляем состав игры/);
  assert.match(bookingCardSource, /state !== "DONE"/);
  assert.match(bookingDialogSource, /completionState === "RETRY_REQUIRED"/);
  assert.match(bookingDialogSource, /setSubmitError\(result\.message/);
});

test("GameJoin decline delegates to server and never patches roster in the browser", () => {
  const declineSource = sourceSlice(
    gameJoinSource,
    "if (target === \"decline\")",
    "const existingSplitPayment",
  );
  assert.match(declineSource, /apiLeavePadelGameAsCurrentUser\(actualGame\.id\)/);
  assert.match(declineSource, /state === "RETRY_REQUIRED"/);
  assert.match(declineSource, /state === "IN_PROGRESS"/);
  assert.match(declineSource, /state !== "DONE"/);
  assert.doesNotMatch(declineSource, /apiCancelPadelSelfRemovalBookings/);
  assert.doesNotMatch(declineSource, /apiUpdatePadelGameRecord/);
});

test("GamesPage self leave delegates to server and never patches roster locally", () => {
  const leaveSource = sourceSlice(
    gamesPageSource,
    "const handleLeaveCurrentUserFromDetails = useCallback",
    "const handleSplitJoinCurrentUserFromDetails = useCallback",
  );
  assert.match(leaveSource, /apiLeavePadelGameAsCurrentUser\(gameRecordId\)/);
  assert.match(leaveSource, /state === "RETRY_REQUIRED"/);
  assert.match(leaveSource, /state === "IN_PROGRESS"/);
  assert.match(leaveSource, /state === "DONE"/);
  assert.doesNotMatch(leaveSource, /apiCancelPadelSelfRemovalBookings/);
  assert.doesNotMatch(leaveSource, /patchGameRoster\(/);
});

test("cancellation close refreshes bookings, subscriptions and game records", () => {
  const refreshSource = sourceSlice(
    cabinetSource,
    "const loadBookings = async () =>",
    "const openBookingHistory",
  );
  assert.match(refreshSource, /apiFetchBookings\(false\)/);
  assert.match(refreshSource, /apiFetchSubscriptions\(\)/);
  assert.match(refreshSource, /apiFetchPadelGamesByPhone/);
  assert.match(refreshSource, /setCreatedGames\(mergedGames\)/);
});

test("rejected roster CAS refreshes server state instead of applying an optimistic fallback", () => {
  assert.match(gameJoinSource, /const authoritative = await apiFetchPadelGameRecord\(game\.id\)/);
  assert.doesNotMatch(gameJoinSource, /participants:\s*mergedParticipants,[\s\S]{0,180}fallback/);
  assert.match(gamesPageSource, /patch_rejected_authoritative_refreshed/);
  assert.match(gamesPageSource, /recordMode\?: "merge" \| "replace"/);
  assert.match(gamesPageSource, /next\[existingIndex\] = recordForStore/);
  assert.match(gamesPageSource, /recordMode: "replace"/);
  assert.match(gamesPageSource, /Array\.isArray\(activeGameRecord\?\.participants\)/);
  assert.match(gamesPageSource, /Array\.isArray\(activeGameRecord\?\.waitlist\)/);
  assert.doesNotMatch(gamesPageSource, /fallbackApplied:\s*true/);
});

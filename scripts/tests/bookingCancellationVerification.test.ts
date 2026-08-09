import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const dialogSource = fs.readFileSync(
  "src/components/cabinet/BookingCancellationDialog.tsx",
  "utf8",
);
const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const tournamentApiSource = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
const cleanupQuerySource = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_split_cleanup_query.js",
  "utf8",
);
const cleanupPrepareSource = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_split_cleanup_prepare.js",
  "utf8",
);
const cleanupRouterSource = fs.readFileSync(
  "scripts/nodered_games_nodes/fn_split_cleanup_router.js",
  "utf8",
);

test("shared booking cancellation verifier checks both active and cancelled booking lists", () => {
  const helperStart = apiClientSource.indexOf("export async function apiVerifyBookingCancellation");
  const helperEnd = apiClientSource.indexOf(
    "export async function apiFetchBookingCancellationOptions",
    helperStart,
  );
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = apiClientSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /apiFetchBookings\(false/);
  assert.match(helperSource, /apiFetchBookings\(true/);
  assert.match(helperSource, /lastVerification\.state === "cancelled"/);
  assert.match(helperSource, /Viva всё ещё держит запись активной/);
});

test("generic 404 is not classified as already cancelled without read-back", () => {
  const helperStart = apiClientSource.indexOf("function isAlreadyCancelledBookingResponse");
  const helperEnd = apiClientSource.indexOf("export async function apiCancelBooking", helperStart);
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = apiClientSource.slice(helperStart, helperEnd);
  assert.doesNotMatch(helperSource, /statusCode === 404/);
  assert.match(helperSource, /\[400, 409, 422\]/);
});

test("shared cancellation dialog waits for Viva read-back before success", () => {
  assert.match(dialogSource, /apiVerifyBookingCancellation\(bookingId\)/);
  assert.match(dialogSource, /verification\.data\?\.state === "cancelled"/);
  assert.match(dialogSource, /action\.id === "subscription"/);
  assert.match(dialogSource, /apiReleaseSubscriptionBookingClaim\(bookingId\)/);
});

test("cabinet direct fallback and tournament registration cancellation verify Viva state", () => {
  assert.match(cabinetSource, /apiVerifyBookingCancellation\(bookingId\)/);
  assert.match(tournamentApiSource, /apiVerifyBookingCancellation\(resolvedBookingId\)/);
  assert.match(tournamentApiSource, /verificationResult\.data\?\.state !== "cancelled"/);
  assert.match(tournamentApiSource, /apiReleaseSubscriptionBookingClaim\(resolvedBookingId\)/);
});

test("subscription daily claim release is authenticated, exact-booking and post-verification only", () => {
  const helperStart = apiClientSource.indexOf("export async function apiReleaseSubscriptionBookingClaim");
  const helperEnd = apiClientSource.indexOf(
    "export async function apiCancelPadelSelfRemovalBookings",
    helperStart,
  );
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = apiClientSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /\/lk\/subscription-bookings\?operationId=/);
  assert.match(helperSource, /auth: true/);
  assert.match(helperSource, /JSON\.stringify\(\{ action: "release", bookingId \}\)/);
  assert.match(cabinetSource, /apiVerifyBookingCancellation\(bookingId\)[\s\S]*apiReleaseSubscriptionBookingClaim\(bookingId\)/);
});

test("self-removal records an unverified booking as failure instead of local success", () => {
  const helperStart = apiClientSource.indexOf(
    "export async function apiCancelPadelSelfRemovalBookings",
  );
  const helperEnd = apiClientSource.indexOf(
    "export async function apiFetchPadelGamesByPhone",
    helperStart,
  );
  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  const helperSource = apiClientSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /statusByBookingId\[bookingId\] = "needs_verification"/);
  assert.match(helperSource, /bookingFailed\.push\(bookingId\)/);
  assert.match(helperSource, /await verifyCancelled\(bookingId/);
});

test("organizer cleanup carries the selected cancellation action through Viva execution", () => {
  assert.match(cabinetSource, /cancellationActionId: action\.id/);
  assert.match(cabinetSource, /actorBookingId: bookingId/);
  assert.match(apiClientSource, /cancellationActionId\?: BookingCancellationAction\["id"\]/);
  assert.match(apiClientSource, /actorBookingId\?: string/);
  assert.match(apiClientSource, /auth: true/);
  assert.match(cleanupQuerySource, /cancellationActionId/);
  assert.match(cleanupQuerySource, /actorBookingId/);
  assert.match(cleanupPrepareSource, /cancellationActionId/);
  assert.match(cleanupPrepareSource, /actorMatchesOrganizer/);
  assert.match(cleanupRouterSource, /ctx\.cancellationActionId/);
  assert.match(cleanupRouterSource, /END_USER_API/);
  assert.match(cleanupRouterSource, /adminRefundMethod: "SERVICE"/);
  assert.doesNotMatch(cleanupRouterSource, /ADMIN_API.*\/bookings\/\$\{encodedId\}/);
});

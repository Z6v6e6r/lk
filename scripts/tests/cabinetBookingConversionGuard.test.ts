import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  BOOKING_CONVERSION_PAID_PUBLICATION_UNAVAILABLE,
  BOOKING_CONVERSION_UNVERIFIED,
  evaluateBookingConversionEvidence,
  hasPaidConvertedOpenGameJoin,
} from "../../src/components/games/bookingConversionEvidence.ts";
import { moscowBookingEndIso } from "../../src/utils/bookingEndTime.ts";
import type { PadelGameRecordPayload } from "../../src/utils/apiClient.ts";

const bookingsContainerSource = fs.readFileSync("src/components/cabinet/BookingsContainer.tsx", "utf8");
const bookingHistorySource = fs.readFileSync("src/components/cabinet/BookingHistory.tsx", "utf8");
const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("cabinet booking lists use shared booking category resolver", () => {
  assert.match(bookingsContainerSource, /resolveCabinetBookingCategory/);
  assert.match(bookingHistorySource, /resolveCabinetBookingCategory/);
  assert.doesNotMatch(bookingsContainerSource, /function getBookingCategory\(/);
  assert.doesNotMatch(bookingHistorySource, /function getBookingCategory\(/);
});

test("cabinet opens create-from-booking flow only for open games and court rentals", () => {
  assert.match(
    cabinetSource,
    /if \(!isExerciseConvertibleToGameFromBooking\(booking\)\) return;/,
  );
  assert.match(
    cabinetSource,
    /if \(resolveExerciseCategoryFromValue\(booking\) !== EXERCISE_CATEGORY_OPEN_GAME\) return null;/,
  );
  assert.match(cabinetSource, /typeId,/);
  assert.match(cabinetSource, /directionId,/);
  assert.match(cabinetSource, /typeName: pickStringFromUnknown\(exercise\.type\?\.name\)/);
});

test("games overlay blocks booking conversion outside open games and court rentals", () => {
  assert.match(gamesPageSource, /resolveExerciseCategoryFromValue\(\{\s*typeId,/s);
  assert.match(gamesPageSource, /isExerciseConvertibleToGameFromBooking\(\{/);
  assert.match(
    gamesPageSource,
    /Из этой брони нельзя создать сборную игру\. Конвертация доступна только для открытой игры или аренды корта\./,
  );
  assert.match(gamesPageSource, /typeId: bookingPreset\.typeId/);
  assert.match(gamesPageSource, /directionId: bookingPreset\.directionId/);
});

test("conversion checks direct Viva evidence before publication and stops on any read or guard failure", () => {
  const handler = gamesPageSource.slice(
    gamesPageSource.indexOf("const handleCreateGameFromBooking ="),
    gamesPageSource.indexOf("const handleCreateGame ="),
  );
  assert.match(handler, /apiFetchBookings\(false, \{ fresh: true \}\)/);
  assert.match(handler, /apiFetchExerciseBookings\(bookingPreset\.exerciseId, \{ fresh: true \}\)/);
  assert.doesNotMatch(handler, /apiFetchTournamentParticipants\(/);
  assert.match(handler, /if \(selfResult\.error \|\| rosterResult\.error\) \{\s*setGameRecordError\(BOOKING_CONVERSION_UNVERIFIED\);\s*return;/);
  assert.match(handler, /if \(!conversionEvidence\.allowed\) \{\s*setGameRecordError\(conversionEvidence\.message\);\s*return;/);
  assert.ok(handler.indexOf("evaluateBookingConversionEvidence({") < handler.indexOf("await apiCreatePadelGameRecord(payload)"));
  assert.match(handler, /const rosterRows = conversionEvidence\.roster/);
  assert.match(handler, /finally \{\s*setCreatingFromBooking\(false\)/);
  const existingBranch = handler.slice(handler.indexOf("if (existing)"), handler.indexOf("let clientId"));
  assert.doesNotMatch(existingBranch, /runPaidGameCommunityMembershipAndPublication/);
  const repairCall = gamesPageSource.indexOf('runPaidGameCommunityMembershipAndPublication(activeGameRecord, "existing_open")');
  const repairEffect = gamesPageSource.slice(gamesPageSource.lastIndexOf("useEffect(() => {", repairCall), repairCall);
  assert.match(repairEffect, /useEffect\(\(\) => \{\s*if \(isBookingPresetMode\) return;/);
});

const pageAst = ts.createSourceFile("GamesPage.tsx", gamesPageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const reconcileAst = ts.createSourceFile(
  "rosterSyncReconcile.ts",
  fs.readFileSync("src/components/games/rosterSyncReconcile.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function extractFunctions(file: ts.SourceFile, names: string[]) {
  return names.map((name) => {
    const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, `Missing ${name}`);
    return fn.getText(file).replace(/^export /, "");
  }).join("\n");
}

function extractConversionCallback(node: ts.Node): string | undefined {
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "handleCreateGameFromBooking"
    && node.initializer
    && ts.isCallExpression(node.initializer)
  ) {
    return node.initializer.arguments[0].getText(pageAst);
  }
  return ts.forEachChild(node, extractConversionCallback);
}

const conversionCallback = extractConversionCallback(pageAst);
assert.ok(conversionCallback);
const conversionCode = ts.transpileModule(`
  ${extractFunctions(pageAst, [
    "isRecordObject", "normalizeBookingId", "normalizeComparableId", "normalizeComparableName",
    "isGenericComparableName", "normalizePhoneForGame", "normalizeVivaBookingParticipant",
    "dedupePlayersByIdentity", "extractVivaBookingId", "extractVivaBookingPaymentTypes",
    "hasVivaSubscriptionBookingSignal",
  ])}
  ${extractFunctions(reconcileAst, ["normalizePhone", "playersShareRosterIdentity"])}
  return (${conversionCallback});
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const organizerBooking = { id: "booking-1", isCancelled: false, visitConfirmed: false, paymentType: "ONE_TIME" };
const organizerProfile = { id: "actor-1", phone: ["7", "999", "0000001"].join(""), name: "Organizer" };

async function runBookingConversion(
  roster: Record<string, unknown>[],
  organizerDraftHasId: boolean,
  options: { typeId?: number; typeName?: string; joinPrice?: string } = {},
) {
  const bookingPreset = {
    hasRequiredBookingData: true, canCreateFromPreset: true, exerciseId: "exercise-1",
    bookingId: organizerBooking.id, studioId: "studio-1", roomId: "room-1",
    date: "2030-01-01", timeFrom: "18:30", timeTo: "20:00", paid: true, amount: 7500,
    typeId: options.typeId, typeName: options.typeName,
  };
  const exercise = {
    id: bookingPreset.exerciseId, studio: { id: bookingPreset.studioId }, room: { id: bookingPreset.roomId },
    timeFrom: "2030-01-01T18:30:00+03:00", timeTo: "2030-01-01T20:00:00+03:00",
  };
  const payloads: PadelGameRecordPayload[] = [];
  const errors: string[] = [];
  const noop = () => {};
  const scope = {
    isBookingPresetMode: true, creatingFromBooking: false, bookingPreset,
    setCreatingFromBooking: noop, setGameRecordError: (value: string | null) => { if (value) errors.push(value); },
    setGameRosterError: noop,
    activeGameRecordStore: null, communityGames: [], createFromBooking: bookingPreset,
    findGameRecordByBookingData: () => null, profileId: organizerProfile.id, profilePhone: organizerProfile.phone,
    participants: [{ ...organizerProfile, id: organizerDraftHasId ? organizerProfile.id : null }],
    profileName: organizerProfile.name, profilePhoto: null, profileGrade: null, profileRatingNumeric: null,
    apiFetchBookings: async () => ({ data: [{ ...organizerBooking, exercise }] }),
    apiFetchExerciseBookings: async () => ({ data: roster }),
    BOOKING_CONVERSION_PAID_PUBLICATION_UNAVAILABLE, BOOKING_CONVERSION_UNVERIFIED,
    evaluateBookingConversionEvidence, hasPaidConvertedOpenGameJoin, moscowBookingEndIso,
    effectiveRatingGame: false, isPrivate: true, waitlistEnabled: true, createMaxPlayers: 4,
    resolvedGameFormat: "doubles", gameTitleDraft: "", gameParticipantCommentDraft: "", gameJoinPriceDraft: options.joinPrice ?? "",
    buildGameOptionalMetadataFields: noop, publicCreatePreciseRatingMetadata: {},
    buildCommunityAutopublishMetadataFields: noop, buildCommunityAutopublishMetadata: noop,
    apiCreatePadelGameRecord: async (payload: PadelGameRecordPayload) => {
      payloads.push(payload);
      return { data: { ...payload, id: "game-1" } };
    },
    upsertGameRecordInStores: noop, runPaidGameCommunityMembershipAndPublication: noop,
    setGameRecordId: noop, setGameRecordStatus: noop, setInviteLink: noop, resolveGameInviteUrl: noop,
    setGamePaymentUrl: noop, setGamePaid: noop, setGameSnapshot: noop,
    mergeMatchSnapshots: noop, buildMatchSnapshotFromPayload: noop, buildMatchSnapshotFromRecord: noop,
    setConfirmCancelUnpaidGame: noop, setStep: noop,
  };
  const publish = new Function(...Object.keys(scope), conversionCode)(...Object.values(scope));
  await publish();
  return { payloads, errors };
}

async function publishFromBooking(roster: Record<string, unknown>[], organizerDraftHasId = true) {
  const { payloads, errors } = await runBookingConversion(roster, organizerDraftHasId);
  assert.deepEqual(errors, []);
  assert.equal(payloads.length, 1);
  return payloads[0];
}

test("a paid open-game conversion stops before creating an LK game", async () => {
  const result = await runBookingConversion([organizerBooking], true, { typeId: 1613, joinPrice: "1050" });
  assert.deepEqual(result.payloads, []);
  assert.deepEqual(result.errors, [BOOKING_CONVERSION_PAID_PUBLICATION_UNAVAILABLE]);
});

test("a converted court rental preserves the organizer's invitation flow", async () => {
  const result = await runBookingConversion([organizerBooking], true, { typeName: "Аренда корта", joinPrice: "1050" });
  assert.equal(result.payloads.length, 1);
  assert.deepEqual(result.errors, []);
});

test("paid open-game join policy also recognizes the legacy direction, and preserves other flows", () => {
  const converted = { source: "cabinet_booking_convert", directionId: 4588, joinPrice: 1050 };
  assert.equal(hasPaidConvertedOpenGameJoin(converted), true);
  assert.equal(hasPaidConvertedOpenGameJoin({ ...converted, joinPrice: "0" }), false);
  assert.equal(hasPaidConvertedOpenGameJoin({ ...converted, source: "games_widget" }), false);
  assert.equal(hasPaidConvertedOpenGameJoin({ ...converted, directionId: undefined, typeName: "Аренда корта" }), false);
});

test("publishing the organizer's booking with no client data uses only one place", async () => {
  const payload = await publishFromBooking([{ ...organizerBooking, client: null }], false);
  assert.deepEqual(payload.participants?.map(({ id, name, status, source, vivaBookingId }) => (
    { id, name, status, source, vivaBookingId }
  )), [{ id: "actor-1", name: "Organizer", status: "CONFIRMED", source: "ORGANIZER", vivaBookingId: "booking-1" }]);
  assert.deepEqual(payload.booking.bookingIds, ["booking-1"]);
  assert.equal(payload.payment.paid, true);
});

test("publishing a full roster preserves identifiable participants and linked bookings", async () => {
  const payload = await publishFromBooking([
    organizerBooking,
    { id: "booking-2", client: { id: "actor-2", firstName: "Second" }, isCancelled: false, visitConfirmed: true },
    { id: "booking-3", clientId: "actor-3", isCancelled: false, visitConfirmed: false, paymentType: "SUBSCRIPTION" },
    { id: "booking-4", client: { id: "actor-4", firstName: "Fourth" }, isCancelled: false, visitConfirmed: true },
    { id: "booking-5", client: { id: "actor-5" }, isCancelled: false, status: "WAITLIST" },
    { id: "booking-6", client: { id: "actor-6" }, isCancelled: true },
  ]);
  assert.deepEqual(payload.participants?.map(({ id, vivaBookingId, status }) => ({ id, vivaBookingId, status })), [
    { id: "actor-1", vivaBookingId: "booking-1", status: "CONFIRMED" },
    { id: "actor-2", vivaBookingId: "booking-2", status: "CONFIRMED" },
    { id: "actor-3", vivaBookingId: "booking-3", status: "PENDING" },
    { id: "actor-4", vivaBookingId: "booking-4", status: "CONFIRMED" },
  ]);
  assert.deepEqual(payload.booking.bookingIds, ["booking-1", "booking-2", "booking-3", "booking-4", "booking-5"]);
  assert.deepEqual(payload.payment.bookingIds, payload.booking.bookingIds);
  assert.equal(payload.metadata?.hasSubscriptionBooking, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  normalizeTournamentSignupListSnapshotState,
} from "../../src/utils/tournamentSignupListSnapshot.ts";
import { normalizeTournamentSignupPublicRoster } from "../../src/utils/tournamentSignupRoster.ts";

test("public tournament roster keeps confirmed participants and waitlist separately", () => {
  const roster = normalizeTournamentSignupPublicRoster({
    payload: [
      {
        id: "booking-1",
        status: "CONFIRMED",
        client: {
          id: "client-1",
          firstName: "Анна",
          lastName: "Иванова",
          photo: "https://example.com/anna.png",
        },
        rating: "C+",
      },
      {
        id: "booking-1-duplicate",
        status: "PAID",
        client: {
          id: "client-1",
          firstName: "Анна",
          lastName: "Иванова",
        },
      },
      {
        id: "booking-2",
        state: "WAITLIST",
        client: {
          id: "client-2",
          firstName: "Борис",
          lastName: "Петров",
        },
      },
      {
        id: "booking-3",
        status: "CANCELLED",
        client: {
          id: "client-3",
          firstName: "Сергей",
          lastName: "Сидоров",
        },
      },
      {
        id: "booking-4",
        status: "REGISTERED",
        clientName: "Игорь Смирнов",
        phone: "+7 (999) 111-22-33",
        rating: "3.50000",
        role: "PLAYER",
      },
    ],
  });

  assert.equal(roster.participantsCount, 2);
  assert.equal(roster.waitlistCount, 1);
  assert.deepEqual(
    roster.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      level: participant.level,
      ratingNumeric: participant.ratingNumeric,
      role: participant.role,
    })),
    [
      {
        id: "client-1",
        name: "Анна Иванова",
        level: "C+",
        ratingNumeric: null,
        role: null,
      },
      {
        id: "booking-4",
        name: "Игорь Смирнов",
        level: "3.50000",
        ratingNumeric: 3.5,
        role: "PLAYER",
      },
    ],
  );
  assert.equal(roster.participants[0]?.avatarUrl, "https://example.com/anna.png");
});

test("public tournament page loads roster through anonymous participants endpoint", () => {
  const pageSource = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");
  const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");

  assert.match(
    pageSource,
    /apiFetchTournamentParticipants\(normalizedExerciseId,\s*\{[\s\S]*?auth:\s*false,[\s\S]*?retries:\s*0,[\s\S]*?signal:\s*options\.signal/,
  );
  assert.match(apiClientSource, /auth:\s*options\.auth\s*\?\?\s*true/);
});

test("public tournament list never fans out participant requests", () => {
  const pageSource = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");
  const loadListStart = pageSource.indexOf("const loadList = useCallback(async");
  const loadDetailStart = pageSource.indexOf("const loadDetail = useCallback(async", loadListStart);

  assert.notEqual(loadListStart, -1);
  assert.notEqual(loadDetailStart, -1);

  const loadListSource = pageSource.slice(loadListStart, loadDetailStart);
  assert.doesNotMatch(loadListSource, /loadPublicRoster/);
  assert.doesNotMatch(loadListSource, /apiFetchTournamentParticipants/);
  assert.doesNotMatch(loadListSource, /\.forEach\s*\(/);
});

test("public tournament list requests one server-coordinated day revalidation", () => {
  const pageSource = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");
  const apiSource = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
  const loadListStart = pageSource.indexOf("const loadList = useCallback(async");
  const loadDetailStart = pageSource.indexOf("const loadDetail = useCallback(async", loadListStart);
  const listSource = pageSource.slice(loadListStart, loadDetailStart);
  const apiListStart = apiSource.indexOf("export async function apiFetchTournamentSignupList");
  const apiListEnd = apiSource.indexOf("export async function apiFetchTournamentMechanicsSourceList", apiListStart);
  const apiListSource = apiSource.slice(apiListStart, apiListEnd);

  assert.match(listSource, /refresh:\s*options\.requestRefresh\s*\?\s*"if-stale"\s*:\s*null/);
  assert.match(listSource, /const refreshTournamentList = useCallback\(async \(\) =>/);
  assert.doesNotMatch(listSource, /setTimeout/);
  assert.doesNotMatch(listSource, /setInterval/);
  assert.doesNotMatch(listSource, /apiFetchTournamentParticipants/);
  assert.match(pageSource, /if \(!listMountedRef\.current\) return/);
  assert.match(pageSource, /listMountedRef\.current = false;\s*listRequestIdRef\.current \+= 1/);
  assert.match(apiListSource, /allowFallback:\s*!params\.refresh/);
  assert.match(apiListSource, /retries:\s*params\.refresh\s*\?\s*0\s*:\s*1/);
  assert.match(apiListSource, /snapshot\s*\?\s*filterSnapshotVisibleTournamentSummaries\(data\)/);
  assert.doesNotMatch(apiListSource, /snapshot\s*\?\s*await filterVisibleTournamentSummaries/);
});

test("tournament list snapshot envelope exposes revalidation state", () => {
  assert.deepEqual(
    normalizeTournamentSignupListSnapshotState({
      items: [],
      snapshotAgeMs: 120000,
      lastSuccessfulAt: "2026-08-13T09:00:00.000Z",
      stale: true,
      refreshInProgress: true,
      snapshotAvailable: true,
      snapshotRefreshEnabled: true,
      snapshotReadModelEnabled: true,
      refreshScheduled: false,
      refreshCompleted: true,
      refreshReason: "refreshed",
      retryAfterMs: 60000,
    }),
    {
      snapshotAgeMs: 120000,
      lastSuccessfulAt: "2026-08-13T09:00:00.000Z",
      stale: true,
      refreshInProgress: true,
      snapshotAvailable: true,
      snapshotRefreshEnabled: true,
      snapshotReadModelEnabled: true,
      refreshScheduled: false,
      refreshCompleted: true,
      refreshReason: "refreshed",
      retryAfterMs: 60000,
    },
  );
  assert.equal(normalizeTournamentSignupListSnapshotState([]), null);
});

test("public tournament detail performs one abortable no-retry roster request", () => {
  const pageSource = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");
  const loadDetailStart = pageSource.indexOf("const loadDetail = useCallback(async");
  const pricingStart = pageSource.indexOf("const ensurePricingPreviewLoaded", loadDetailStart);

  assert.notEqual(loadDetailStart, -1);
  assert.notEqual(pricingStart, -1);

  const loadDetailSource = pageSource.slice(loadDetailStart, pricingStart);
  assert.match(loadDetailSource, /publicRosterDetailAbortRef\.current\?\.abort\(\)/);
  assert.match(loadDetailSource, /new AbortController\(\)/);
  assert.match(loadDetailSource, /loadPublicRoster\(exerciseId,\s*\{\s*signal:\s*rosterAbortController\.signal\s*\}\)/);
  assert.doesNotMatch(loadDetailSource, /force:\s*true/);
});

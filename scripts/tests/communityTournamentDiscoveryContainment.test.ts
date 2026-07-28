import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const loaderSource = fs.readFileSync("src/components/cabinet/CommunitiesSectionLoader.tsx", "utf8");
const widgetTypeSource = fs.readFileSync("src/types/communitiesWidget.ts", "utf8");
const entrySource = fs.readFileSync("src/communities.tsx", "utf8");
const communitiesSource = fs.readFileSync("src/components/cabinet/CommunitiesSection.tsx", "utf8");
const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function sourceSlice(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("community tournament discovery reuses the cabinet active-booking exercise ids", () => {
  assert.match(cabinetSource, /const activeBookingExerciseIds = useMemo\(\(\) => \{/);
  assert.match(cabinetSource, /collectBookingExerciseIds\(booking\)/);
  assert.match(cabinetSource, /<CommunitiesSectionLoader[\s\S]*activeBookingExerciseIds=\{activeBookingExerciseIds\}/);
  assert.match(loaderSource, /activeBookingExerciseIds/);
  assert.match(widgetTypeSource, /activeBookingExerciseIds\?: string\[\]/);
  assert.match(entrySource, /activeBookingExerciseIds=\{data\.activeBookingExerciseIds\}/);
});

test("community tournament composer performs one abortable period request and no participant fan-out", () => {
  const discoverySource = sourceSlice(
    communitiesSource,
    "const loadFeedTournamentOptions = async () => {",
    "const feedGameRecords = useMemo(() => {",
  );

  assert.match(discoverySource, /apiFetchExercisesByPeriod\(todayKey, lastDateKey/);
  assert.match(discoverySource, /retries: 0/);
  assert.match(discoverySource, /signal: abortController\.signal/);
  assert.match(discoverySource, /activeBookingExerciseIdSet\.has\(exerciseId\)/);
  assert.doesNotMatch(discoverySource, /Promise\.all/);
  assert.doesNotMatch(discoverySource, /apiFetchTournamentParticipants/);
});

test("community-only participant stat warmup is single-flight, abortable and has no retry", () => {
  const warmupSource = sourceSlice(
    communitiesSource,
    "const warmFeedTournamentStats = useCallback(async (tournamentId: string) => {",
    "const handlePlayCommunityGame =",
  );

  assert.match(warmupSource, /warmingTournamentStatIdsRef\.current\.has\(normalizedTournamentId\)/);
  assert.match(warmupSource, /apiFetchTournamentParticipants\(normalizedTournamentId, \{/);
  assert.match(warmupSource, /retries: 0/);
  assert.match(warmupSource, /signal: abortController\.signal/);
  assert.match(apiClientSource, /apiFetchTournamentParticipants\([\s\S]*retries: options\.retries \?\? 1/);
});

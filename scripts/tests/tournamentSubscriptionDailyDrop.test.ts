import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  formatTournamentSubscriptionDropCountdown,
  resolveNextTournamentSubscriptionDailyDropAt,
} from "../../src/utils/tournamentSubscriptionDailyDrop.ts";

test("daily-drop countdown targets today's 10:00 Europe/Moscow before the drop", () => {
  const now = new Date("2026-07-14T06:59:59.000Z");
  assert.equal(resolveNextTournamentSubscriptionDailyDropAt(now).toISOString(), "2026-07-14T07:00:00.000Z");
});

test("daily-drop countdown targets tomorrow's 10:00 Europe/Moscow at and after the drop", () => {
  assert.equal(
    resolveNextTournamentSubscriptionDailyDropAt(new Date("2026-07-14T07:00:00.000Z")).toISOString(),
    "2026-07-15T07:00:00.000Z",
  );
  assert.equal(
    resolveNextTournamentSubscriptionDailyDropAt(new Date("2026-07-14T20:30:00.000Z")).toISOString(),
    "2026-07-15T07:00:00.000Z",
  );
});

test("daily-drop countdown formats a padded clock and never becomes negative", () => {
  assert.equal(formatTournamentSubscriptionDropCountdown(10_000, 0), "00:00:10");
  assert.equal(formatTournamentSubscriptionDropCountdown(3_661_000, 0), "01:01:01");
  assert.equal(formatTournamentSubscriptionDropCountdown(0, 1_000), "00:00:00");
});

test("sold-out RA and Friendship cards render the countdown without the daily note", () => {
  const sourceText = fs.readFileSync(
    new URL("../../src/components/tournament-subscription/TournamentSubscriptionPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(sourceText, /plan\.counterKey === "ra" \|\| plan\.counterKey === "friendship"/);
  assert.match(sourceText, /<DailyDropCountdown onDrop=\{loadStatus\} \/>/);
  assert.match(sourceText, /До обновления счетчика/);
  assert.doesNotMatch(sourceText, /Следующий дроп через/);
  assert.doesNotMatch(sourceText, /Ежедневно в 10:00 МСК/);
});

test("status refresh ignores stale responses around the daily drop boundary", () => {
  const sourceText = fs.readFileSync(
    new URL("../../src/components/tournament-subscription/TournamentSubscriptionPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(sourceText, /const statusRequestIdRef = useRef\(0\)/);
  assert.match(sourceText, /const requestId = statusRequestIdRef\.current \+ 1/);
  assert.match(sourceText, /if \(requestId !== statusRequestIdRef\.current\) return/);
});

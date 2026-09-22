import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  clearTournamentOrganizerEntryFromUrl,
  readTournamentOrganizerEntryFromHref,
  TOURNAMENT_ORGANIZER_QUERY_KEY,
} from "../../src/utils/tournamentOrganizerEntry.ts";

test("reads the organizer deep link flag without a tournament target", () => {
  const entry = readTournamentOrganizerEntryFromHref("https://padlhub.ru/lk_new?openTournaments=1");

  assert.equal(TOURNAMENT_ORGANIZER_QUERY_KEY, "openTournaments");
  assert.equal(entry.enabled, true);
  assert.equal(entry.tournamentId, null);
  assert.equal(entry.tournamentSlug, null);
  assert.equal(entry.date, null);
});

test("reads tournament id, slug and date from the organizer deep link", () => {
  const entry = readTournamentOrganizerEntryFromHref(
    "https://padlhub.ru/lk_new?openTournaments=1&tournamentId=exercise-1&slug=Cup%20Final&date=2026-05-05",
  );

  assert.equal(entry.enabled, true);
  assert.equal(entry.tournamentId, "exercise-1");
  assert.equal(entry.tournamentSlug, "cup final");
  assert.equal(entry.date, "2026-05-05");
});

test("supports exerciseId, tournamentSlug and datetime date aliases", () => {
  const entry = readTournamentOrganizerEntryFromHref(
    "https://padlhub.ru/lk_new?openTournaments&exerciseId=exercise-2&tournamentSlug=summer-cup&date=2026-07-05T09:00:00",
  );

  assert.equal(entry.enabled, true);
  assert.equal(entry.tournamentId, "exercise-2");
  assert.equal(entry.tournamentSlug, "summer-cup");
  assert.equal(entry.date, "2026-07-05");
});

test("ignores an unparseable date instead of failing the deep link", () => {
  const entry = readTournamentOrganizerEntryFromHref(
    "https://padlhub.ru/lk_new?openTournaments=1&date=not-a-date",
  );

  assert.equal(entry.enabled, true);
  assert.equal(entry.date, null);
});

test("ignores links without the organizer flag", () => {
  const entry = readTournamentOrganizerEntryFromHref(
    "https://padlhub.ru/lk_new?tournamentId=exercise-1&slug=cup&date=2026-05-05",
  );

  assert.equal(entry.enabled, false);
  assert.equal(entry.tournamentId, null);
  assert.equal(entry.tournamentSlug, null);
  assert.equal(entry.date, null);
});

test("treats explicit false-ish organizer flags as disabled", () => {
  ["0", "false", "no", "off", "FALSE"].forEach((flagValue) => {
    const entry = readTournamentOrganizerEntryFromHref(
      `https://padlhub.ru/lk_new?openTournaments=${flagValue}&tournamentId=exercise-1`,
    );
    assert.equal(entry.enabled, false, `flag ${flagValue} must not open the module`);
    assert.equal(entry.tournamentId, null);
  });
});

test("clearing removes organizer params and keeps unrelated ones", () => {
  const url = new URL(
    "https://padlhub.ru/lk_new?openTournaments=1&tournamentId=exercise-1&slug=cup&date=2026-05-05&channel=dev#anchor",
  );
  const cleared = clearTournamentOrganizerEntryFromUrl(url);

  assert.equal(cleared.pathname, "/lk_new");
  assert.equal(cleared.searchParams.get("channel"), "dev");
  assert.equal(cleared.searchParams.has("openTournaments"), false);
  assert.equal(cleared.searchParams.has("tournamentId"), false);
  assert.equal(cleared.searchParams.has("slug"), false);
  assert.equal(cleared.searchParams.has("date"), false);
  assert.equal(cleared.hash, "#anchor");
  // исходный URL не мутируется
  assert.equal(url.searchParams.get("openTournaments"), "1");
});

test("LK app router opens the tournaments organizer overlay from the deep link", () => {
  const appSource = fs.readFileSync("src/MyApp.tsx", "utf8");

  assert.match(appSource, /readTournamentOrganizerEntryFromHref\(currentUrl\.toString\(\)\)/);
  assert.match(appSource, /clearTournamentOrganizerEntryFromUrl\(currentUrl\)/);
  assert.match(
    appSource,
    /openOverlayModule\(\s*"tournaments",\s*TOURNAMENTS_BUNDLE_URL,\s*"LKWidgetTournaments"/,
  );
  assert.match(appSource, /tournamentId: tournamentOrganizerEntry\.tournamentId/);
});

test("cabinet tournament quick action opens the organizer module only for hosts", () => {
  const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");

  assert.match(
    cabinetSource,
    /const openTournamentsOrganizer = action\.label === "Турниры" && canHostTournaments;/,
  );
  assert.match(cabinetSource, /if \(openTournamentsOrganizer\)/);
  assert.match(cabinetSource, /onClick=\{\(\) => handleOpenTournaments\(\)\}/);
  assert.match(
    cabinetSource,
    /\{ icon: "🏆", label: "Турниры", href: "https:\/\/padlhub\.ru\/tournaments" \}/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH,
  normalizeTournamentSignupDate,
  normalizeTournamentSignupPublicUrl,
  normalizeTournamentSignupSlug,
  readTournamentSignupEntryDataFromHref,
} from "../../src/utils/tournamentSignupEntry.ts";

test("readTournamentSignupEntryDataFromHref resolves tournamentId, slug and date from query", () => {
  const routeData = readTournamentSignupEntryDataFromHref(
    "https://padlhub.ru/tournaments?tournamentId=abc123&slug=Summer-Cup&date=2026-07-10",
  );

  assert.equal(routeData.tournamentId, "abc123");
  assert.equal(routeData.tournamentSlug, "summer-cup");
  assert.equal(routeData.date, "2026-07-10");
});

test("readTournamentSignupEntryDataFromHref falls back to id aliases", () => {
  const routeData = readTournamentSignupEntryDataFromHref(
    "https://padlhub.ru/tournaments?exerciseId=exercise-42&tournamentSlug=night-mix",
  );

  assert.equal(routeData.tournamentId, "exercise-42");
  assert.equal(routeData.tournamentSlug, "night-mix");
});

test("normalizeTournamentSignupPublicUrl rewrites legacy api public links to signup page", () => {
  const url = new URL(normalizeTournamentSignupPublicUrl(
    "https://padlhub.ru/api/tournaments/public/Summer-Cup?date=2026-07-10",
  ));

  assert.equal(url.pathname, DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH);
  assert.equal(url.searchParams.get("slug"), "Summer-Cup");
  assert.equal(url.searchParams.get("date"), "2026-07-10");
});

test("normalizeTournamentSignupPublicUrl keeps canonical public tournaments route", () => {
  const url = new URL(normalizeTournamentSignupPublicUrl(
    "https://padlhub.ru/tournaments?tournamentId=abc123&slug=summer-cup",
  ));

  assert.equal(url.pathname, DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH);
  assert.equal(url.searchParams.get("tournamentId"), "abc123");
  assert.equal(url.searchParams.get("slug"), "summer-cup");
});

test("normalizeTournamentSignupPublicUrl rewrites legacy tournament_signup route", () => {
  const url = new URL(normalizeTournamentSignupPublicUrl(
    "https://padlhub.ru/tournament_signup?tournamentId=abc123&slug=summer-cup",
  ));

  assert.equal(url.pathname, DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH);
  assert.equal(url.searchParams.get("tournamentId"), "abc123");
  assert.equal(url.searchParams.get("slug"), "summer-cup");
});

test("normalize helpers keep canonical slug and date formatting", () => {
  assert.equal(normalizeTournamentSignupSlug(" Summer%20Cup "), "summer cup");
  assert.equal(normalizeTournamentSignupDate("2026-07-10T18:30:00+03:00"), "2026-07-10");
});

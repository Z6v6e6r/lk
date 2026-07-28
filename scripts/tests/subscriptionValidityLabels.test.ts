import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  formatSubscriptionValidityLabel,
  pickSubscriptionValidityDate,
  resolveSubscriptionStatusTone,
  resolveSubscriptionUsageDisplay,
} from "../../src/utils/subscriptionValidity.ts";

test("subscription validity formatter uses a stable Russian date label", () => {
  assert.equal(formatSubscriptionValidityLabel("2026-07-01"), "до 01.07.2026");
  assert.equal(formatSubscriptionValidityLabel("2026-07-01T20:30:00+03:00", "действует до"), "действует до 01.07.2026");
});

test("subscription validity picker reads direct and nested Viva date aliases", () => {
  assert.equal(
    pickSubscriptionValidityDate({ activeTo: "2026-07-02" }),
    "2026-07-02",
  );
  assert.equal(
    pickSubscriptionValidityDate({ subscription: { validUntil: "2026-07-03" } }),
    "2026-07-03",
  );
});

test("subscription usage labels keep date by default and visits for Energy packs", () => {
  assert.deepEqual(
    resolveSubscriptionUsageDisplay({
      subscriptionName: "Лето.Падел.РА",
      validityDate: "2026-07-12",
      visitsLeft: 30,
      validityPrefix: "действует до",
    }),
    { kind: "validity", label: "действует до 12.07.2026" },
  );
  assert.deepEqual(
    resolveSubscriptionUsageDisplay({
      subscriptionName: "Энергия 25",
      validityDate: "2026-07-12",
      visitsLeft: 8,
    }),
    { kind: "visits", label: "8 занятий" },
  );
});

test("subscription status tone matches cabinet fills", () => {
  assert.equal(resolveSubscriptionStatusTone("Лето.Падел.Спорт"), "green");
  assert.equal(resolveSubscriptionStatusTone("Лето.Падел.Дружба"), "green");
  assert.equal(resolveSubscriptionStatusTone("Энергия 5 🎾"), "green");
  assert.equal(resolveSubscriptionStatusTone("Энергия 25"), "green");
  assert.equal(resolveSubscriptionStatusTone("Лето.Падел.РА"), "gold");
  assert.equal(resolveSubscriptionStatusTone("Лето.Падел.Академия"), "gold");
  assert.equal(resolveSubscriptionStatusTone("РА"), "gold");
  assert.equal(resolveSubscriptionStatusTone("Академия"), "gold");
  assert.equal(resolveSubscriptionStatusTone("Абонемент"), null);
});

test("subscription usage labels route all subscription UI through shared formatter", () => {
  const cabinetCardSource = fs.readFileSync("src/components/cabinet/SubscroptionCard.tsx", "utf8");
  const appCssSource = fs.readFileSync("src/MyApp.css", "utf8");
  const subscriptionInfoSource = fs.readFileSync("src/components/cabinet/SubscriptionInformation.tsx", "utf8");
  const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const groupScheduleSource = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.tsx", "utf8");
  const tournamentSignupSource = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");

  assert.match(cabinetCardSource, /sub-validity-badge/);
  assert.doesNotMatch(cabinetCardSource, /visitsLeft\}\s+из\s+\{subscription\.visitsTotal\}/);
  assert.doesNotMatch(subscriptionInfoSource, /Посещений:/);
  assert.doesNotMatch(gamesPageSource, /осталось занятий:/);
  assert.match(cabinetCardSource, /resolveSubscriptionStatusTone/);
  assert.match(appCssSource, /sub-status-badge--green/);
  assert.match(appCssSource, /sub-status-badge--gold/);
  assert.match(appCssSource, /\.sub-status-badge\.active\.sub-status-badge--green/);
  assert.match(appCssSource, /\.sub-status-badge\.inactive\.sub-status-badge--gold/);
  assert.match(cabinetCardSource, /resolveSubscriptionUsageDisplay/);
  assert.match(subscriptionInfoSource, /resolveSubscriptionUsageDisplay/);
  assert.match(gamesPageSource, /function formatSplitSubscriptionValidityLabel/);
  assert.match(groupScheduleSource, /function formatProductValidity/);
  assert.match(tournamentSignupSource, /function formatTournamentPaymentProductValidity/);
});

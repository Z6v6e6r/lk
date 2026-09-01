import assert from "node:assert/strict";
import test from "node:test";
import {
  createGameAtlasRequestCoordinator,
  isDisplayableGameAtlasRecord,
  matchesAtlasAvailability,
  matchesAtlasCategory,
  matchesAtlasMultiValue,
  matchesAtlasSearchText,
  matchesAtlasTimeOfDay,
  parseAtlasMultiValues,
  resolveGameAtlasPagination,
  serializeAtlasMultiValues,
  toggleAtlasMultiValue,
} from "../../src/components/games/gameAtlasAcceptanceModel.ts";

test("rapid Atlas replacements accept only the latest response", () => {
  const coordinator = createGameAtlasRequestCoordinator();
  const first = coordinator.start("replace");
  const latest = coordinator.start("replace");
  assert.ok(first);
  assert.ok(latest);
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(latest), true);
  assert.equal(coordinator.start("append"), null);

  coordinator.finish(first);
  assert.equal(coordinator.start("append"), null);
  coordinator.finish(latest);

  const append = coordinator.start("append");
  assert.ok(append);
  assert.equal(coordinator.start("append"), null);
  coordinator.finish(append);
  assert.ok(coordinator.start("append"));
});

test("a stale append cannot block pagination after a replacement", () => {
  const coordinator = createGameAtlasRequestCoordinator();
  const staleAppend = coordinator.start("append");
  assert.ok(staleAppend);

  const replacement = coordinator.start("replace");
  assert.ok(replacement);
  coordinator.finish(replacement);

  const currentAppend = coordinator.start("append");
  assert.ok(currentAppend);
  assert.equal(coordinator.isCurrent(currentAppend), true);

  coordinator.finish(staleAppend);
  assert.equal(coordinator.start("append"), null);
  coordinator.finish(currentAppend);
  assert.ok(coordinator.start("append"));
});

test("malformed records never become clickable Atlas cards", () => {
  const valid = {
    id: "game:valid",
    booking: {
      date: "2026-09-02",
      timeFrom: "18:30",
      studioId: "studio:piter",
      studioName: "PadlHub SPB",
    },
  };
  assert.equal(isDisplayableGameAtlasRecord(valid), true);
  assert.equal(isDisplayableGameAtlasRecord({ id: "id-only" }), false);
  assert.equal(isDisplayableGameAtlasRecord({ ...valid, id: "" }), false);
  assert.equal(isDisplayableGameAtlasRecord({ ...valid, booking: { ...valid.booking, date: "bad" } }), false);
  assert.equal(isDisplayableGameAtlasRecord({ ...valid, booking: { ...valid.booking, date: "2026-02-31" } }), false);
  assert.equal(isDisplayableGameAtlasRecord({ ...valid, booking: { ...valid.booking, timeFrom: "24:00" } }), false);
  assert.equal(isDisplayableGameAtlasRecord({ ...valid, booking: { ...valid.booking, timeFrom: "" } }), false);
  assert.equal(isDisplayableGameAtlasRecord({ ...valid, booking: { ...valid.booking, studioId: "", studioName: "" } }), false);
});

test("pagination advances by raw consumed items and stops on an empty malformed page", () => {
  assert.deepEqual(
    resolveGameAtlasPagination({ requestedOffset: 50, consumedCount: 50, serverHasMore: true }),
    { nextOffset: 100, hasMore: true },
  );
  assert.deepEqual(
    resolveGameAtlasPagination({ requestedOffset: 50, consumedCount: 0, serverHasMore: true }),
    { nextOffset: 50, hasMore: false },
  );
});

test("search supports valid, empty, no-result and special-character queries", () => {
  const fields = ["Лето.Падел", "PadlHub — Санкт-Петербург", "Сергеев Тренер"];
  assert.equal(matchesAtlasSearchText(fields, "падел санкт"), true);
  assert.equal(matchesAtlasSearchText(fields, "лето.падел"), true);
  assert.equal(matchesAtlasSearchText(fields, ""), true);
  assert.equal(matchesAtlasSearchText(fields, "несуществующая игра"), false);

  const rapidlyTyped = ["п", "па", "пад", "падел", "другая"];
  const latestResult = rapidlyTyped.map((query) => matchesAtlasSearchText(fields, query)).at(-1);
  assert.equal(latestResult, false);
});

test("categories and one/multi/conflicting filters are deterministic", () => {
  const now = Date.UTC(2026, 8, 1, 12);
  assert.equal(matchesAtlasCategory("all", false, false, null, now), true);
  assert.equal(matchesAtlasCategory("open", true, false, now, now), true);
  assert.equal(matchesAtlasCategory("open", false, false, now, now), false);
  assert.equal(matchesAtlasCategory("mine", true, true, now, now), true);
  assert.equal(matchesAtlasCategory("mine", true, false, now, now), false);
  assert.equal(matchesAtlasCategory("upcoming", true, false, now + 1, now), true);
  assert.equal(matchesAtlasCategory("upcoming", true, false, null, now), false);

  assert.equal(matchesAtlasAvailability(true, ["available"]), true);
  assert.equal(matchesAtlasAvailability(false, ["available"]), false);
  assert.equal(matchesAtlasAvailability(false, ["available", "full"]), true);
  assert.equal(matchesAtlasMultiValue(["OPEN", "PAID"], "PAID"), true);
  assert.equal(matchesAtlasMultiValue(["OPEN"], "FULL"), false);
  assert.equal(matchesAtlasTimeOfDay(10 * 60, ["morning", "evening"]), true);
  assert.equal(matchesAtlasTimeOfDay(12 * 60, ["morning", "evening"]), false);
});

test("multi-select URL state round-trips, resets and combines with search", () => {
  const selected = toggleAtlasMultiValue<string>([], "available", "__all__");
  const multi = toggleAtlasMultiValue(selected, "full", "__all__");
  assert.deepEqual(multi, ["available", "full"]);
  const encoded = serializeAtlasMultiValues([...multi, "available"]);
  assert.equal(encoded, "available,full");
  assert.deepEqual(parseAtlasMultiValues(encoded, ["available", "full"]), multi);
  assert.deepEqual(toggleAtlasMultiValue(multi, "__all__", "__all__"), []);

  const combinedMatch = matchesAtlasSearchText(["PadlHub SPB"], "spb")
    && matchesAtlasAvailability(true, ["available"])
    && matchesAtlasTimeOfDay(19 * 60, ["evening"]);
  assert.equal(combinedMatch, true);
});

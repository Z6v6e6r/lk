import test from "node:test";
import assert from "node:assert/strict";
import { buildPadelAvailableGamesQuery } from "../../src/utils/gameAtlasAvailableGamesQuery.ts";

test("Atlas sends the full supported client-side search window to the games endpoint", () => {
  const result = buildPadelAvailableGamesQuery({
    limit: 500,
    offset: 25,
    date: "2026-09-01",
    stationId: "station-1",
    stationName: "Питер",
  }, { isDevReleaseChannel: true });
  const { query } = result;

  assert.equal(result.limit, 500);
  assert.equal(result.offset, 25);
  assert.equal(query.get("public"), "true");
  assert.equal(query.get("available"), "true");
  assert.equal(query.get("limit"), "500");
  assert.equal(query.get("offset"), "25");
  assert.equal(query.get("date"), "2026-09-01");
  assert.equal(query.get("stationId"), "station-1");
  assert.equal(query.get("studioId"), "station-1");
  assert.equal(query.get("stationName"), "Питер");
  assert.equal(query.get("studioName"), "Питер");
  assert.equal(query.has("_ts"), false);
});

test("Atlas clamps oversized requests at 500 and keeps production cache busting", () => {
  const result = buildPadelAvailableGamesQuery(
    { limit: 1000, offset: -5 },
    { isDevReleaseChannel: false, now: () => 12345 },
  );
  const { query } = result;

  assert.equal(result.limit, 500);
  assert.equal(result.offset, 0);
  assert.equal(query.get("limit"), "500");
  assert.equal(query.get("offset"), "0");
  assert.equal(query.get("_ts"), "12345");
});

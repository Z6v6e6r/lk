import test from "node:test";
import assert from "node:assert/strict";
import { getCommunityRatingMonthStartTs, isCommunityRatingSnapshotForPeriod } from "../../src/services/community-rating/contract.ts";
import { resolveRatingWorkerCommunityIds } from "../rating_worker.mjs";
const nowTs = Date.parse("2026-10-09T12:00:00.000Z");

test("client rejects rolling, previous-month, missing and future snapshots for the monthly control", () => {
  const current = "2026-09-30T21:00:00.000Z";
  assert.equal(isCommunityRatingSnapshotForPeriod("month", "month", current, nowTs), true);
  assert.equal(isCommunityRatingSnapshotForPeriod("month", "30d", current, nowTs), false);
  assert.equal(isCommunityRatingSnapshotForPeriod("month", "month", "2026-09-30T20:59:59.999Z", nowTs), false);
  assert.equal(isCommunityRatingSnapshotForPeriod("month", "month", null, nowTs), false);
  assert.equal(isCommunityRatingSnapshotForPeriod("month", "month", "2026-11-01T00:00:00Z", nowTs), false);
  assert.equal(isCommunityRatingSnapshotForPeriod("all", "all", null, nowTs), true);
  assert.equal(isCommunityRatingSnapshotForPeriod("30d", "30d", current, nowTs), true);
});

test("incremental worker refreshes quiet communities on bootstrap and month rollover, then resumes changed-only selection", async () => {
  const queries: Array<{ name: string; filter: Record<string, unknown> }> = [];
  const db = { collection(name: string) {
    return { find(filter: Record<string, unknown>) {
      queries.push({ name, filter });
      return { async toArray() {
        return name === "lk_communities" && !filter.$or ? [{ id: "quiet-a" }, { id: "quiet-b" }] : [];
      } };
    } };
  } };
  for (const marker of [undefined, Date.parse("2026-08-31T21:00:00Z")]) {
    const registry = { watermark: "2026-10-09T11:45:00Z", communityRatingMonthStartTs: marker };
    const before = { ...registry };
    assert.deepEqual(await resolveRatingWorkerCommunityIds(db, {
      mode: "incremental", sinceIso: registry.watermark, registry, nowTs,
    }), ["quiet-a", "quiet-b"]);
    assert.deepEqual(registry, before, "selection must not advance the success marker");
  }
  queries.length = 0;
  assert.deepEqual(await resolveRatingWorkerCommunityIds(db, {
    mode: "incremental", sinceIso: "2026-10-09T11:45:00Z",
    registry: { watermark: "2026-10-09T11:45:00Z", communityRatingMonthStartTs: getCommunityRatingMonthStartTs(nowTs) }, nowTs,
  }), []);
  assert.ok(queries.some((query) => query.name === "lk_games"), "same-month run still discovers changed source data");
});

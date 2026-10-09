import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  getCommunityRatingMonthStartTs,
  isCommunityRatingSnapshotForPeriod,
} from "../../src/services/community-rating/contract.ts";
import { getCommunityRatingMonthLabel } from "../../src/components/cabinet/community-feed/useCommunityRatingMonth.ts";
import { resolveRatingWorkerCommunityIds } from "../rating_worker.mjs";

const nowTs = Date.parse("2026-10-09T12:00:00.000Z");

test("month label follows Moscow calendar across UTC midnight and year rollover", () => {
  assert.equal(getCommunityRatingMonthLabel(getCommunityRatingMonthStartTs(nowTs)), "Октябрь");
  assert.equal(getCommunityRatingMonthLabel(getCommunityRatingMonthStartTs(Date.parse("2026-10-31T21:00:00Z"))), "Ноябрь");
  assert.equal(getCommunityRatingMonthLabel(getCommunityRatingMonthStartTs(Date.parse("2026-12-31T21:00:00Z"))), "Январь");
});

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

const patchSource = fs.readFileSync("scripts/patch_nodered_communities_flow.mjs", "utf8");
const common = patchSource.split("const commonHelpers = String.raw`")[1].split("\n`;")[0];

function runRatingNode(name: string, msg: Record<string, unknown>) {
  const body = patchSource.split("const " + name + " = `${commonHelpers}")[1].split("\n`;")[0];
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? nowTs); }
    static now() { return nowTs; }
  }
  return vm.runInNewContext("(function(msg) {" + common + body + "\n})(msg)", { msg, Date: FixedDate });
}

test("Node-RED monthly query uses a separate current-month snapshot and preserves community access control", () => {
  const msg = {
    _communityRatingCtx: { communityId: "community-1", period: "month", tab: "overall" },
    payload: [{ id: "community-1", visibility: "OPEN" }],
  };
  const result = runRatingNode("fnRankingQuery", msg);
  assert.equal(result[0].payload.period, "month");
  assert.equal(result[0].payload.updatedAtTs.$gte, Date.parse("2026-09-30T21:00:00Z"));
  assert.equal(result[0].payload.updatedAtTs.$lte, nowTs);
  for (const period of ["all", "30d", "week"]) {
    const legacy = runRatingNode("fnRankingQuery", { ...msg, _communityRatingCtx: { ...msg._communityRatingCtx, period }, payload: [{ id: "community-1" }] });
    assert.equal(legacy[0].payload.period, period === "week" ? "30d" : period);
    assert.equal(legacy[0].payload.updatedAtTs, undefined);
  }
  const forbidden = runRatingNode("fnRankingQuery", { ...msg, payload: [{ id: "community-1", visibility: "CLOSED", members: [] }] });
  assert.equal(forbidden[0], null);
  assert.equal(forbidden[1].statusCode, 403);
});

test("missing monthly snapshot returns 503 with no rolling fallback", () => {
  const result = runRatingNode("fnRankingSnapshotResponse", {
    _communityRatingCtx: { communityId: "community-1", period: "month", tab: "overall" }, payload: [],
  });
  assert.equal(result[0].statusCode, 503);
  assert.equal(result[0].payload.error, "RATING_SNAPSHOT_NOT_READY");
  assert.equal(result[0].payload.period, "month");
  assert.equal(result[1], null);
});

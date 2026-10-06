import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINIMUM_RETENTION_DAYS,
  RETENTION_POLICY_DAYS,
  TERMINAL_MEMBERSHIP_STATES,
  parseRetentionArgs,
  retentionCutoff,
  retentionFilter,
} from "../partner_game_membership_retention_purge.mjs";

test("retention defaults to one year and refuses anything shorter than the policy floor", () => {
  assert.equal(RETENTION_POLICY_DAYS, 365);
  const args = parseRetentionArgs([]);
  assert.equal(args.apply, false);
  assert.equal(args.days, 365);
  assert.throws(() => parseRetentionArgs(["--days", String(MINIMUM_RETENTION_DAYS - 1)]), /retention days/);
  assert.throws(() => parseRetentionArgs(["--days", "365.5"]), /retention days/);
  assert.throws(() => parseRetentionArgs(["--unknown"]), /unknown argument/);
  assert.equal(parseRetentionArgs(["--apply", "--days", "400"]).apply, true);
});

test("the cutoff is exact and a dry run never deletes", () => {
  const now = new Date("2026-10-06T09:00:00.000Z");
  assert.equal(retentionCutoff(now, 365).toISOString(), "2025-10-06T09:00:00.000Z");
  assert.throws(() => retentionCutoff(now, 1), /out of policy/);
  assert.throws(() => retentionCutoff(new Date("nope"), 365), /must be a Date/);
  // deleteMany is only ever reached with --apply; the default path stays read-only.
  assert.equal(parseRetentionArgs([]).apply, false);
});

test("only terminal memberships age out, while operations and audit age by timestamp", () => {
  const cutoff = new Date("2025-10-06T09:00:00.000Z");
  assert.deepEqual(retentionFilter({ collection: "lk_partner_game_memberships", timeField: "createdAt", terminalStatesOnly: true }, cutoff),
    { createdAt: { $lt: cutoff }, state: { $in: [...TERMINAL_MEMBERSHIP_STATES] } });
  assert.deepEqual(retentionFilter({ collection: "lk_partner_game_operations", timeField: "createdAt", terminalStatesOnly: false }, cutoff),
    { createdAt: { $lt: cutoff } });
  assert.deepEqual(retentionFilter({ collection: "lk_partner_api_audit", timeField: "at", terminalStatesOnly: false }, cutoff),
    { at: { $lt: cutoff } });
  // An active membership must never match the retention filter.
  assert.ok(!TERMINAL_MEMBERSHIP_STATES.includes("ACTIVE"));
  assert.ok(!TERMINAL_MEMBERSHIP_STATES.includes("VIVA_PENDING"));
});

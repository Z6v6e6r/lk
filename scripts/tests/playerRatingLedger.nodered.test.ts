import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("result flow patch wires canonical rating event before player state", () => {
  const patchSource = fs.readFileSync("scripts/patch_nodered_results_flow.mjs", "utf8");
  const eventFormatterSource = fs.readFileSync(
    "scripts/nodered_result_nodes/fn_result_rating_ledger_event_msg.js",
    "utf8",
  );
  const stateFormatterSource = fs.readFileSync(
    "scripts/nodered_result_nodes/fn_result_rating_ledger_state_msg.js",
    "utf8",
  );

  assert.match(patchSource, /collection:\s*'rating_events'/);
  assert.match(patchSource, /wires:\s*\[\[ratingLedgerStateFormatter\.id\]\]/);
  assert.match(patchSource, /ratingLedgerEventFormatter\.wires = \[\['result_rating_ledger_append_001'\]\]/);
  assert.match(patchSource, /ratingLedgerStateFormatter\.wires = \[\[playerRatingWrite\.id\]\]/);
  assert.match(patchSource, /playerRatingWrite\.wires = \[\['result_rating_compatibility_prepare_001'\]\]/);
  assert.match(patchSource, /collection:\s*'player_ratings'/);
  assert.match(patchSource, /wires:\s*\[\['result_rating_ledger_projection_001'\]\]/);
  assert.match(
    patchSource,
    /wires:\s*\[\['result_viva_sync_outbox_prepare_002', 'result_viva_sync_request_prepare_002'\]\]/,
  );
  assert.match(eventFormatterSource, /eventOperation/);
  assert.match(stateFormatterSource, /_ratingLedgerStateOperation/);
});

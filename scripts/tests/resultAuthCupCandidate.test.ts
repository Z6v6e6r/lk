import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("scripts/build_result_auth_cup_candidate.mjs", "utf8");

test("focused result auth candidate is pinned to a verified live preimage", () => {
  assert.match(
    source,
    /EXPECTED_SOURCE_SHA256 = "7ad8c39769809d458fa9c36bb76ba38d11d756d2a1e72c99c63f0f6685e7c546"/,
  );
  assert.match(source, /EXPECTED_NODE_COUNT = 4734/);
  assert.match(source, /EXPECTED_ROUTE_COUNT = 211/);
  assert.match(source, /Function preimage mismatch/);
  assert.match(source, /Unexpected changed node count/);
  assert.match(source, /Broken candidate topology/);
});
test("focused candidate changes only the shared result auth hop", () => {
  assert.match(source, /authPrepare\.func = readCandidate\("fn_result_auth_prepare\.js"\)/);
  assert.match(source, /authResolve\.func = readCandidate\("fn_result_auth_profile\.js"\)/);
  assert.match(source, /authRequest\.name = "Verify result actor via CUP JWT or Viva profile"/);
  assert.match(source, /defaultTargets: "none"/);
  assert.match(source, /phaseOneTargets: "state"/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(
  "src/components/tournament-signup/TournamentSignupPage.tsx",
  "utf8",
);

test("automatic tournament checkout waits for the current registration lookup", () => {
  assert.match(
    pageSource,
    /const \[registrationResolvedFor, setRegistrationResolvedFor\] = useState<string \| null>\(null\)/,
  );

  const loadDetailStart = pageSource.indexOf("const loadDetail = useCallback");
  const loadDetailEnd = pageSource.indexOf("const ensurePricingPreviewLoaded", loadDetailStart);
  const loadDetailSource = pageSource.slice(loadDetailStart, loadDetailEnd);
  const lookupStart = loadDetailSource.indexOf("setRegistrationResolvedFor(null)");
  const lookupAwait = loadDetailSource.indexOf("await Promise.all");
  const registrationCommit = loadDetailSource.indexOf("setRegistration(resolvedRegistration)");
  const resolutionCommit = loadDetailSource.indexOf(
    "setRegistrationResolvedFor(`${tournamentId}:${exerciseId}`)",
  );

  assert.ok(lookupStart >= 0, "detail load must clear a stale registration resolution");
  assert.ok(lookupAwait > lookupStart, "registration lookup must start after clearing the resolution");
  assert.ok(registrationCommit > lookupAwait, "registration state must be committed after the lookup");
  assert.ok(
    resolutionCommit > registrationCommit,
    "the current tournament/exercise key must be resolved only after registration state",
  );

  const checkoutGateStart = pageSource.indexOf("const registrationResolutionKey");
  const checkoutGateEnd = pageSource.indexOf("useEffect(() =>", checkoutGateStart);
  const checkoutGateSource = pageSource.slice(checkoutGateStart, checkoutGateEnd);
  const resolutionGuard = checkoutGateSource.indexOf(
    "registrationResolvedFor !== registrationResolutionKey",
  );
  const checkoutStart = checkoutGateSource.indexOf("void loadCheckout(mode)");

  assert.ok(resolutionGuard >= 0, "automatic checkout must verify the current resolution key");
  assert.ok(checkoutStart > resolutionGuard, "checkout must start only after the resolution guard");
});

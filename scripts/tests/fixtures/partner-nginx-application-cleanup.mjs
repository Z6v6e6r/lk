// Local fixture-only test seam; caller has already checked exact ID ownership.
// A log failure must not skip cleanup. A cleanup failure remains a hard failure.
export function collectFixtureLogThenCleanup(collectLog, cleanup) {
  let logCollectionFailed = false;
  try { collectLog(); } catch { logCollectionFailed = true; }
  cleanup();
  return { logCollectionFailed };
}

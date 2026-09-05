export const FENCE_RELEASE_CONFIRMATION = "RELEASE_VIVA_GAME_PROJECTION_CUTOVER_FENCE_V1";
export const FENCE_RECOVERY_CONFIRMATION = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
export const FENCE_READY_CONFIRMATION = "FINALIZE_VIVA_GAME_PROJECTION_READY_V1";
const RECOVERY_ARGUMENT_KEYS = [
  "--barrier-artifact", "--expected-barrier-artifact-sha256", "--cutover-plan",
  "--expected-cutover-plan-sha256", "--migration-connection-file",
  "--execution-index", "--expected-execution-index-sha256",
  "--fence-receipt", "--expected-fence-receipt-sha256",
  "--fence-guardian-receipt", "--expected-fence-guardian-receipt-sha256",
  "--fence-guardian-recovery-request", "--report",
].sort();
const READY_ARGUMENT_KEYS = [
  "--execution-index", "--expected-execution-index-sha256",
  "--coordinator-report", "--expected-coordinator-report-sha256",
].sort();

export function isAuthorizedFenceGuardianRelease({ release, validPrivateFile, fenceTokenSha256, nowMs = Date.now() }) {
  const authorizedAt = Date.parse(release?.authorizedAt);
  return validPrivateFile === true && release?.formatVersion === 1
    && release?.kind === "viva-game-projection-fence-release-request"
    && release?.state === "RELEASE_AUTHORIZED" && release?.confirmation === FENCE_RELEASE_CONFIRMATION
    && release?.fenceTokenSha256 === fenceTokenSha256 && Number.isFinite(authorizedAt)
    && authorizedAt <= nowMs + 60_000 && nowMs - authorizedAt <= 5 * 60_000;
}

export function isAuthorizedRecoveryFenceTakeoverRelease({
  release,
  validPrivateFile,
  fenceTokenSha256,
  recoveryRequestId,
  recoveryReportPath,
  recoveryReport,
  recoveryReportSha256,
  recoveryTerminalJournal,
  recoveryTerminalJournalSha256,
  recoveryFenceTakeoverReceiptPath,
  recoveryFenceTakeoverReceiptSha256,
  nowMs = Date.now(),
}) {
  return isAuthorizedFenceGuardianRelease({ release, validPrivateFile, fenceTokenSha256, nowMs })
    && release?.recoveryRequestId === recoveryRequestId
    && release?.recoveryReportPath === recoveryReportPath
    && release?.recoveryReportSha256 === recoveryReportSha256
    && release?.recoveryTerminalJournalSha256 === recoveryTerminalJournalSha256
    && release?.recoveryFenceTakeoverReceiptSha256 === recoveryFenceTakeoverReceiptSha256
    && recoveryReport?.formatVersion === 1
    && recoveryReport?.kind === "viva-game-projection-mongo-write-barrier-recovery-receipt"
    && recoveryReport?.state === "RELEASED_TO_EXACT_PREIMAGE"
    && recoveryReport?.guardianRecoveryRequestId === recoveryRequestId
    && recoveryReport?.recoveryJournalPath === `${recoveryReportPath}.journal`
    && recoveryReport?.recoveryFenceTakeoverState === "HELD_UNTIL_EXPLICIT_FENCE_RELEASE"
    && recoveryReport?.recoveryFenceTakeoverReceiptPath === recoveryFenceTakeoverReceiptPath
    && recoveryReport?.recoveryFenceTakeoverReceiptSha256 === recoveryFenceTakeoverReceiptSha256
    && recoveryTerminalJournal?.formatVersion === 1
    && recoveryTerminalJournal?.mode === "BARRIER_RECOVERY"
    && recoveryTerminalJournal?.phase === "TERMINAL_RESULT"
    && recoveryTerminalJournal?.attemptId === recoveryReport?.recoveryAttemptId
    && recoveryTerminalJournal?.reportSha256 === recoveryReportSha256
    && JSON.stringify(recoveryTerminalJournal?.report) === JSON.stringify(recoveryReport);
}

export function isAuthorizedFenceGuardianRecovery({
  request, validPrivateFile, fenceTokenSha256, guardianPid, processStartIdentity, nowMs = Date.now(),
}) {
  const authorizedAt = Date.parse(request?.authorizedAt);
  const argumentKeys = Array.isArray(request?.argv)
    ? request.argv.filter((_, index) => index % 2 === 0).sort()
    : [];
  return validPrivateFile === true && request?.formatVersion === 1
    && request?.kind === "viva-game-projection-fence-recovery-request"
    && request?.state === "RECOVERY_AUTHORIZED" && request?.confirmation === FENCE_RECOVERY_CONFIRMATION
    && request?.fenceTokenSha256 === fenceTokenSha256
    && request?.guardianPid === guardianPid && request?.guardianProcessStartIdentity === processStartIdentity
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(request?.requestId || ""))
    && Array.isArray(request?.argv) && request.argv.length === RECOVERY_ARGUMENT_KEYS.length * 2
    && request.argv.length % 2 === 0 && request.argv.every((value) => typeof value === "string" && value.length <= 4096)
    && JSON.stringify(argumentKeys) === JSON.stringify(RECOVERY_ARGUMENT_KEYS)
    && Number.isFinite(authorizedAt) && authorizedAt <= nowMs + 60_000 && nowMs - authorizedAt <= 5 * 60_000;
}

export function isAuthorizedFenceGuardianReadyFinalization({
  request, validPrivateFile, fenceTokenSha256, guardianPid, processStartIdentity, nowMs = Date.now(),
}) {
  const authorizedAt = Date.parse(request?.authorizedAt);
  const argumentKeys = Array.isArray(request?.argv)
    ? request.argv.filter((_, index) => index % 2 === 0).sort()
    : [];
  return validPrivateFile === true && request?.formatVersion === 1
    && request?.kind === "viva-game-projection-fence-ready-finalization-request"
    && request?.state === "READY_FINALIZATION_AUTHORIZED" && request?.confirmation === FENCE_READY_CONFIRMATION
    && request?.fenceTokenSha256 === fenceTokenSha256
    && request?.guardianPid === guardianPid && request?.guardianProcessStartIdentity === processStartIdentity
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(request?.requestId || ""))
    && Array.isArray(request?.argv) && request.argv.length === READY_ARGUMENT_KEYS.length * 2
    && request.argv.length % 2 === 0 && request.argv.every((value) => typeof value === "string" && value.length <= 4096)
    && JSON.stringify(argumentKeys) === JSON.stringify(READY_ARGUMENT_KEYS)
    && Number.isFinite(authorizedAt) && authorizedAt <= nowMs + 60_000 && nowMs - authorizedAt <= 5 * 60_000;
}

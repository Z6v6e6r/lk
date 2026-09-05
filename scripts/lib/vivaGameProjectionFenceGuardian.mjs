import fs from "node:fs";
import path from "node:path";

import { canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";

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

const CHILD_REQUEST_KIND = {
  recovery: "viva-game-projection-fence-recovery-request",
  ready: "viva-game-projection-fence-ready-finalization-request",
};

const syncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};

export function acceptFenceGuardianChildRequest({ childKind, requestId }) {
  const handshakeFd = Number(process.env.PADLHUB_CUTOVER_GUARDIAN_HANDSHAKE_FD);
  const fenceFd = Number(process.env.PADLHUB_CUTOVER_FENCE_FD);
  const lockPath = String(process.env.PADLHUB_CUTOVER_FENCE_LOCK_PATH || "");
  const requestPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_PATH || "");
  const acceptedPath = String(process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD_ACCEPTED_PATH || "");
  const expectedRequestSha256 = String(process.env.PADLHUB_CUTOVER_GUARDIAN_CHILD_REQUEST_SHA256 || "");
  const expectedKind = CHILD_REQUEST_KIND[childKind];
  if (!expectedKind || !Number.isSafeInteger(handshakeFd) || handshakeFd < 3 || handshakeFd === fenceFd
    || !Number.isSafeInteger(fenceFd) || fenceFd < 3 || !path.isAbsolute(lockPath)
    || !path.isAbsolute(requestPath) || !path.isAbsolute(acceptedPath)
    || !/^[a-f0-9]{64}$/.test(expectedRequestSha256)
    || acceptedPath !== `${requestPath}.accepted-${requestId}` || path.dirname(requestPath) !== path.dirname(acceptedPath)) {
    throw new Error("Fence guardian child handshake environment is invalid");
  }
  const fenceStat = fs.fstatSync(fenceFd);
  const lockStat = fs.statSync(lockPath);
  if (!fenceStat.isFile() || fenceStat.dev !== lockStat.dev || fenceStat.ino !== lockStat.ino) {
    throw new Error("Fence guardian child did not inherit the canonical lock descriptor");
  }
  const requestDescriptor = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let requestStat;
  let requestBytes;
  try {
    requestStat = fs.fstatSync(requestDescriptor);
    requestBytes = fs.readFileSync(requestDescriptor);
  } finally { fs.closeSync(requestDescriptor); }
  let request;
  try { request = JSON.parse(requestBytes.toString("utf8")); } catch {
    throw new Error("Fence guardian child request is invalid");
  }
  if (!requestStat.isFile() || requestStat.isSymbolicLink() || requestStat.nlink !== 1
    || requestStat.uid !== process.getuid?.() || (requestStat.mode & 0o077) !== 0
    || sha256(requestBytes) !== expectedRequestSha256
    || request?.kind !== expectedKind || request?.requestId !== requestId || fs.existsSync(acceptedPath)) {
    throw new Error("Fence guardian child request cannot be accepted exactly");
  }
  const currentRequestStat = fs.lstatSync(requestPath);
  if (currentRequestStat.dev !== requestStat.dev || currentRequestStat.ino !== requestStat.ino) {
    throw new Error("Fence guardian child request changed before acceptance");
  }
  fs.writeSync(handshakeFd, `${canonicalJson({ state: "FENCE_INHERITED", childKind, requestId })}\n`);
  fs.renameSync(requestPath, acceptedPath);
  syncDirectory(path.dirname(requestPath));
  fs.writeSync(handshakeFd, `${canonicalJson({ state: "REQUEST_ACCEPTED", childKind, requestId })}\n`);
  fs.closeSync(handshakeFd);
  return acceptedPath;
}

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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAGMENT_PATH = path.join(SCRIPT_DIR, "lk-subscription-booking-location.conf");
const STATIC_LK_MARKER = "    location ^~ /lk/ {\n        alias /var/www/html/lk/;";
const ROUTE_PATTERN = /location\s*=\s*\/lk\/subscription-bookings\s*\{/g;

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function readSubscriptionBookingLocation(fragmentPath = DEFAULT_FRAGMENT_PATH) {
  const fragment = fs.readFileSync(fragmentPath, "utf8");
  if (!fragment.endsWith("\n")) throw new Error("Subscription booking nginx fragment must end with a newline");
  return fragment;
}

export function buildSubscriptionBookingNginxCandidate(
  source,
  expectedSourceSha,
  fragment = readSubscriptionBookingLocation(),
) {
  const sourceSha = sha256(source);
  if (sourceSha !== expectedSourceSha) {
    throw new Error(`Nginx source SHA mismatch: expected ${expectedSourceSha}, got ${sourceSha}`);
  }

  const routeMatches = [...source.matchAll(ROUTE_PATTERN)];
  if (routeMatches.length > 0) {
    if (routeMatches.length === 1 && source.includes(fragment)) {
      return { candidate: source, changed: false, sourceSha, candidateSha: sourceSha };
    }
    throw new Error("An unmanaged subscription booking nginx location already exists");
  }

  const markerIndex = source.indexOf(STATIC_LK_MARKER);
  if (markerIndex < 0 || source.indexOf(STATIC_LK_MARKER, markerIndex + 1) >= 0) {
    throw new Error("Static /lk/ nginx marker must exist exactly once");
  }

  const candidate = `${source.slice(0, markerIndex)}${fragment}\n${source.slice(markerIndex)}`;
  const candidateRoutes = [...candidate.matchAll(ROUTE_PATTERN)];
  if (candidateRoutes.length !== 1) throw new Error("Candidate must contain exactly one managed location");
  return { candidate, changed: true, sourceSha, candidateSha: sha256(candidate) };
}

function writeCandidate(sourcePath, candidatePath, expectedSourceSha) {
  if (sourcePath === candidatePath) throw new Error("Refusing to overwrite the nginx source while building a candidate");
  const source = fs.readFileSync(sourcePath, "utf8");
  const result = buildSubscriptionBookingNginxCandidate(source, expectedSourceSha);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, result.candidate, "utf8");
  console.log(JSON.stringify({
    sourcePath,
    candidatePath,
    changed: result.changed,
    sourceSha: result.sourceSha,
    candidateSha: result.candidateSha,
  }, null, 2));
}

export function applyCandidate(livePath, candidatePath, expectedSourceSha, expectedCandidateSha, backupPath) {
  if (path.dirname(livePath) !== path.dirname(backupPath)) {
    throw new Error("Nginx backup must stay beside the live config");
  }
  const source = fs.readFileSync(livePath, "utf8");
  const result = buildSubscriptionBookingNginxCandidate(source, expectedSourceSha);
  const candidate = fs.readFileSync(candidatePath, "utf8");
  const candidateSha = sha256(candidate);
  if (!result.changed) throw new Error("Managed nginx location is already installed");
  if (candidateSha !== expectedCandidateSha || result.candidateSha !== expectedCandidateSha) {
    throw new Error("Nginx candidate SHA mismatch");
  }
  if (candidate !== result.candidate) throw new Error("Nginx candidate does not match the guarded builder output");

  const liveStat = fs.statSync(livePath);
  fs.copyFileSync(livePath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, liveStat.mode & 0o777);
  const tempPath = `${livePath}.codex-subscription-booking-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, candidate, { flag: "wx", mode: liveStat.mode & 0o777 });
    fs.renameSync(tempPath, livePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  if (sha256(fs.readFileSync(livePath)) !== expectedCandidateSha) {
    throw new Error("Applied nginx config SHA mismatch");
  }
  console.log(JSON.stringify({ livePath, backupPath, sourceSha: result.sourceSha, candidateSha }, null, 2));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build" && args.length === 3) {
    writeCandidate(path.resolve(args[0]), path.resolve(args[1]), args[2]);
  } else if (command === "apply" && args.length === 5) {
    applyCandidate(path.resolve(args[0]), path.resolve(args[1]), args[2], args[3], path.resolve(args[4]));
  } else {
    throw new Error(
      "Usage: patch_subscription_booking_proxy.mjs build <source> <candidate> <source-sha> | "
      + "apply <live> <candidate> <source-sha> <candidate-sha> <backup>",
    );
  }
}

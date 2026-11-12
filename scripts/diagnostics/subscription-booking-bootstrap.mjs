import fs from "node:fs";
import path from "node:path";
import { createScopedBookingObserver, SUBSCRIPTION_BOOKING_SCOPE } from "./subscription-booking-scope.mjs";
import { atomicWrite } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

function selfTest(release) {
  const events = [], observer = createScopedBookingObserver({ release, sink: event => events.push(event) });
  try {
    for (const status of [409, 503]) observer.observe({ req: { method: "POST", path: "/lk/subscription-bookings" },
      statusCode: status, payload: { details: { code: "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED" } },
      _subscriptionBooking: { caller: "http", action: "book", step: "operation_find" } }, "booking_finalize");
    observer.observe({ req: { method: "POST", path: "/lk/subscription-bookings" } }, "roster_projection_ack",
      { code: "LEGACY_ROSTER_PROJECTION_UNACKNOWLEDGED", httpStatus: 503 });
    if (events.length !== 3 || events.some(event => ![409, 503].includes(event.httpStatus)
      || event.entityRef || event.operationRef || event.bindingRef || event.outboxRef)
      || observer.snapshot().loggerFailures !== 0) throw Error("OBSERVER_SELF_TEST_FAILED");
  } finally { observer.dispose(); }
}
// Settings suffix verifies the immutable bundle before require. Registration does
// not attach middleware and emits no synthetic failures to the production sink.
export function registerSettings(settings, { receiptPath, generation, bundleSha256, release,
  sink = event => console.warn(JSON.stringify(event)) }) {
  if (!/^[a-f0-9]{32}$/.test(generation || "") || !/^[a-f0-9]{64}$/.test(bundleSha256 || "")
    || !/^[a-f0-9]{40}$/.test(release || "") || !path.isAbsolute(receiptPath || "")) throw Error("OBSERVER_CONFIG_INVALID");
  const original = settings.functionGlobalContext;
  if ((original !== undefined && (!original || typeof original !== "object" || Array.isArray(original)))
    || Object.hasOwn(original || {}, "lkDiagnostics")) throw Error("DIAGNOSTIC_SETTINGS_CONFLICT");
  selfTest(release);
  const observer = createScopedBookingObserver({ sink, release });
  try {
    const parent = fs.lstatSync(path.dirname(receiptPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
      || (parent.mode & 0o777) !== 0o700) throw Error("RECEIPT_DIRECTORY_INVALID");
    if (fs.existsSync(receiptPath)) {
      const st = fs.lstatSync(receiptPath);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid()
        || (st.mode & 0o777) !== 0o600) throw Error("RECEIPT_FILE_INVALID");
    }
    settings.functionGlobalContext = { ...original, lkDiagnostics: observer };
    atomicWrite(receiptPath, Buffer.from(JSON.stringify({ kind: "SUBSCRIPTION409_SETTINGS_REGISTERED",
      generation, bundleSha256, pid: process.pid, registered: true, scope: SUBSCRIPTION_BOOKING_SCOPE,
      selfTestPassed: true })), { uid: process.getuid(), gid: process.getgid() });
    return true;
  } catch (error) {
    // Rename is the publication boundary. A later directory-fsync error must
    // never leave a valid READY receipt paired with a removed observer.
    let published;
    try {
      const st = fs.lstatSync(receiptPath);
      const ready = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      published = st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid()
        && (st.mode & 0o777) === 0o600 && ready.kind === "SUBSCRIPTION409_SETTINGS_REGISTERED"
        && ready.registered === true && ready.pid === process.pid && ready.generation === generation
        && ready.bundleSha256 === bundleSha256 && ready.scope === SUBSCRIPTION_BOOKING_SCOPE
        && ready.selfTestPassed === true;
    } catch (probeError) {
      if (probeError.code === "ENOENT" || probeError instanceof SyntaxError) published = false;
    }
    if (published === true && settings.functionGlobalContext?.lkDiagnostics === observer) {
      try { console.warn(JSON.stringify({ event: "SUBSCRIPTION_BOOKING_STARTUP", code: "OBSERVER_READY_DURABILITY_UNKNOWN" })); } catch { /* no-throw */ }
      return true;
    }
    // If readback itself is unavailable, preserve a potentially committed
    // registration; the installer must decide from its guarded postcheck.
    if (published === undefined && settings.functionGlobalContext?.lkDiagnostics === observer) throw error;
    if (original === undefined) delete settings.functionGlobalContext;
    else settings.functionGlobalContext = original;
    observer.dispose();
    throw error;
  }
}

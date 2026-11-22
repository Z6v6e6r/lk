import fs from "node:fs";
import path from "node:path";
import { createScopedObserver } from "./subscription409-scope.mjs";
import { atomicWrite } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

// Called only by the attested settings suffix, after bundle hash/modes were checked.
// Factory failure keeps the original global context; no raw errors are logged.
export function registerSettings(settings, { receiptPath, generation, bundleSha256, release, sink = event => console.warn(JSON.stringify(event)) }) {
  const original = settings.functionGlobalContext;
  if ((original !== undefined && (!original || typeof original !== "object" || Array.isArray(original)))
    || Object.hasOwn(original || {}, "lkDiagnostics")) throw Error("DIAGNOSTIC_SETTINGS_CONFLICT");
  const observer = createScopedObserver({ sink, release });
  try {
    settings.functionGlobalContext = { ...original, lkDiagnostics: observer };
    const parent = fs.lstatSync(path.dirname(receiptPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
      || (parent.mode & 0o777) !== 0o700) throw Error("RECEIPT_DIRECTORY_INVALID");
    if (fs.existsSync(receiptPath)) {
      const current = fs.lstatSync(receiptPath);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid()
        || (current.mode & 0o777) !== 0o600) throw Error("RECEIPT_FILE_INVALID");
    }
    atomicWrite(receiptPath, Buffer.from(JSON.stringify({ kind: "SUBSCRIPTION409_SETTINGS_REGISTERED", generation,
      bundleSha256, pid: process.pid, registered: true })), { uid: process.getuid(), gid: process.getgid() });
    return true;
  } catch (error) {
    if (original === undefined) delete settings.functionGlobalContext;
    else settings.functionGlobalContext = original;
    observer.dispose();
    throw error;
  }
}

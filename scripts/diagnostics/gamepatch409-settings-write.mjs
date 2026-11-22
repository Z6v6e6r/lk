import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { syncDirectory } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

// Preserve the reviewed settings mode without widening the shared flow writer.
export function atomicWriteSettings(destination, bytes, { uid = 0, gid = 0, mode = 0o600 } = {}) {
  if (![0o600, 0o640, 0o644].includes(mode)) throw new Error("Protected atomic write mode is invalid");
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.fchownSync(descriptor, uid, gid);
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}

import fs from "node:fs";
import { assertProtectedFile } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

// -F flock execs Node without forking, so the WRITE lock must belong to this PID.
// An argv/env marker alone is never evidence that the shared lock is held.
export function assertKernelFlock(file, { uid = 0, gid = 0 } = {}) {
  assertProtectedFile(file, { uid, gid, mode: 0o600 });
  const st = fs.statSync(file, { bigint: true }), dev = st.dev;
  const major = ((dev & 0xfff00n) >> 8n) | ((dev & 0xfffff00000000000n) >> 32n);
  const minor = (dev & 0xffn) | ((dev & 0xffffff00000n) >> 12n);
  const locks = fs.readFileSync("/proc/locks", "utf8").split("\n");
  const held = locks.some(line => {
    const m = line.match(/^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s+0\s+EOF$/i);
    return m && Number(m[1]) === process.pid && BigInt(`0x${m[2]}`) === major
      && BigInt(`0x${m[3]}`) === minor && BigInt(m[4]) === st.ino;
  });
  if (!held) throw Error("SHARED_KERNEL_LOCK_REQUIRED");
}

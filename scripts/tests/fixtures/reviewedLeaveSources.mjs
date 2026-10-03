// Immutable source ownership for consumed leave generations. Never derive expected
// candidate hashes from the working file, or update historical production patchers.
// Requires full Git history; the enforcement workflow checks out fetch-depth: 0.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CUP_LEAVE_SOURCE_COMMIT = "e89907e11453da91b8d32c1f4e63a2b566fbeeed";
export const DEMOTION_SOURCE_COMMIT = "bae537b588ac28e9916869d73ba9292a485e292e";
export const PROJECTION_SOURCE_COMMIT = "99422a8e031c65dfcdb005cb1331035fcf672fd2";
// The repeated-booking generation is the newest reviewed owner of these files.
export const CURRENT_LEAVE_SOURCE_COMMIT = "6e532eea9aa3d96a2701b4ce79a9215fd1bd0770";
const root = fileURLToPath(new URL("../../../", import.meta.url));

export function reviewedLeaveSource(file, commit = CURRENT_LEAVE_SOURCE_COMMIT) {
  return execFileSync("git", ["show", `${commit}:scripts/nodered_games_nodes/${file}`], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

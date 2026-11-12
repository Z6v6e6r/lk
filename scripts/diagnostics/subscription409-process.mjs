import { spawnSync } from "node:child_process";

export function createProcessAdapter(spawn = spawnSync) {
  return {
    inspect() {
      const result = spawn("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      if (result.error || result.status !== 0) throw Error("PROCESS_INSPECTION_FAILED");
      const matches = JSON.parse(result.stdout).filter(p => p.name === "node-red");
      if (matches.length !== 1) throw Error("PROCESS_IDENTITY_AMBIGUOUS");
      const p = matches[0];
      return { pid: p.pid, restartCount: p.pm2_env.restart_time, status: p.pm2_env.status };
    },
    restart(expectedCount, { allowOffline = false } = {}) {
      const before = this.inspect();
      if ((before.status !== "online" && !(allowOffline && ["errored", "stopped"].includes(before.status) && before.pid === 0))
        || before.restartCount !== expectedCount) throw Error("PROCESS_DRIFT");
      const result = spawn("pm2", ["restart", "node-red"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      if (result.error || result.status !== 0) throw Error("RESTART_OUTCOME_UNKNOWN");
      return this.inspect();
    },
  };
}

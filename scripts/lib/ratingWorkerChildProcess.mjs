import { spawnSync } from "node:child_process";

export const DEFAULT_RATING_WORKER_CHILD_TIMEOUT_MS = 12 * 60 * 1000;
export const DEFAULT_RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS = 2 * 60 * 1000;

export function resolveRatingWorkerChildTimeoutMs(env = process.env) {
  const parsed = Number(env.RATING_WORKER_CHILD_TIMEOUT_MS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RATING_WORKER_CHILD_TIMEOUT_MS;
}

export function resolveRatingWorkerMongoSocketTimeoutMs(value = process.env.RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RATING_WORKER_MONGO_SOCKET_TIMEOUT_MS;
}

export function spawnRatingWorkerChild(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? resolveRatingWorkerChildTimeoutMs(options.env);
  return spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 200 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
}

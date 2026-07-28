import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, "recalculate_community_rating.mjs");

const passthroughArgs = process.argv.slice(2);
const childArgs = [
  "--experimental-strip-types",
  workerPath,
  "--all",
  ...passthroughArgs,
];

const child = spawn(process.execPath, childArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

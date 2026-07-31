#!/usr/bin/env node
import fs from "node:fs";

const legacySourcePath = process.env.RATING_WORKER_LEGACY_SECRET_SOURCE
  || "/root/tmp-rating-visits-run-20260707/scripts/repair_split_timeout_false_positives.mjs";
const targetPath = process.env.RATING_WORKER_ENV_FILE
  || "/etc/padlhub-rating-worker.env";
const source = fs.readFileSync(legacySourcePath, "utf8");

function pick(constName, envName) {
  const pattern = new RegExp(`const\\s+${constName}\\s*=\\s*getArg\\([^\\n]*process\\.env\\.${envName}\\s*\\|\\|\\s*"([^"]+)"`);
  return source.match(pattern)?.[1] || "";
}

const values = {
  VIVA_CLIENT_ID: process.env.VIVA_CLIENT_ID || pick("vivaClientId", "VIVA_CLIENT_ID"),
  VIVA_USERNAME: process.env.VIVA_USERNAME || pick("vivaUsername", "VIVA_USERNAME"),
  VIVA_PASSWORD: process.env.VIVA_PASSWORD || pick("vivaPassword", "VIVA_PASSWORD"),
  GAME_RESULT_RATING_WORKER_ENABLED: process.env.GAME_RESULT_RATING_WORKER_ENABLED || "false",
  GAME_RESULT_RATING_WORKER_LIMIT: process.env.GAME_RESULT_RATING_WORKER_LIMIT || "20",
};
if (Object.values(values).some((value) => !value || /[\r\n]/.test(value))) {
  throw new Error("Viva runtime credentials are incomplete");
}

const tempPath = `${targetPath}.tmp-${process.pid}`;
fs.writeFileSync(
  tempPath,
  `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  { mode: 0o600 },
);
fs.renameSync(tempPath, targetPath);
fs.chmodSync(targetPath, 0o600);
console.log(JSON.stringify({ ok: true, targetPath, keys: Object.keys(values), mode: "600" }));

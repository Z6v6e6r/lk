import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { validateBuildEnv } from "./lib/build-env.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(scriptPath, "../..");
const mode = process.argv[2] || "production";
const env = {
  ...loadEnv(mode, repoRoot, ""),
  ...process.env,
};
const errors = validateBuildEnv(env);

if (errors.length > 0) {
  console.error(`Build blocked: invalid ${mode} environment:`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  console.error("Restore the ignored .env files or provide the variables explicitly.");
  process.exit(1);
}

console.log(`Build environment verified for mode ${mode}.`);

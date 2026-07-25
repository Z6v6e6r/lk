import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRepositoryProvenance } from "./lib/release-provenance.mjs";

function formatUtcStamp(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

const outDir = process.argv[2];
const fileName = process.argv[3] ?? "release.json";

if (!outDir) {
  console.error("Usage: node scripts/write-release.mjs <outDir> [fileName]");
  process.exit(1);
}

const now = new Date();
const version = (process.env.LK_RELEASE_VERSION || "").trim() || formatUtcStamp(now);
let provenance;
try {
  provenance = readRepositoryProvenance(process.cwd());
} catch (error) {
  console.warn(`Git provenance is unavailable: ${error.message}`);
  provenance = {
    sourceCommit: null,
    sourceBranch: null,
    sourceDirty: true,
  };
}
const payload = {
  version,
  generatedAt: now.toISOString(),
  sourceCommit: provenance.sourceCommit,
  sourceBranch: provenance.sourceBranch,
  sourceDirty: provenance.sourceDirty,
};

const cwd = process.cwd();
const targetDir = resolve(cwd, outDir);
const targetFile = resolve(targetDir, fileName);

await mkdir(targetDir, { recursive: true });
await writeFile(targetFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`Release manifest written to ${targetFile}`);

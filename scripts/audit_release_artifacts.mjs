import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseSha256Inventory(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (!match) {
        throw new Error(`Invalid SHA256 inventory line: ${line}`);
      }
      return {
        remoteSha: match[1].toLowerCase(),
        remotePath: match[2],
      };
    });
}

export function auditReleaseArtifacts(inventory, localDir) {
  return inventory.map(({ remoteSha, remotePath }) => {
    const fileName = basename(remotePath);
    const localPath = join(localDir, fileName);
    let localSha = null;

    try {
      localSha = createHash("sha256")
        .update(readFileSync(localPath))
        .digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    return {
      fileName,
      remoteSha,
      localSha,
      match: localSha === remoteSha,
    };
  });
}

function main() {
  const [inventoryPath, localDir, option] = process.argv.slice(2);
  if (!inventoryPath || !localDir || (option && option !== "--require-all-match")) {
    console.error(
      "Usage: node scripts/audit_release_artifacts.mjs <sha256-inventory> <local-dir> [--require-all-match]",
    );
    process.exit(1);
  }

  const inventory = parseSha256Inventory(readFileSync(inventoryPath, "utf8"));
  const results = auditReleaseArtifacts(inventory, localDir);
  console.log(JSON.stringify(results, null, 2));

  if (option === "--require-all-match" && results.some((item) => !item.match)) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

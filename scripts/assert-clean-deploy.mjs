import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readRepositoryProvenance,
  validateReleaseManifestProvenance,
} from "./lib/release-provenance.mjs";
import {
  releaseArtifactNames,
  validateBundleRuntimeConfig,
} from "./lib/build-env.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(scriptPath, "../..");
const manifestArgs = process.argv.slice(2);

let repository;
try {
  repository = readRepositoryProvenance(repoRoot);
} catch (error) {
  console.error(`Deploy blocked: cannot read Git provenance: ${error.message}`);
  process.exit(1);
}

if (repository.sourceDirty) {
  console.error(
    `Deploy blocked: working tree contains ${repository.changes.length} tracked or untracked change(s).`,
  );
  for (const change of repository.changes.slice(0, 20)) {
    console.error(`  ${change}`);
  }
  if (repository.changes.length > 20) {
    console.error(`  ... and ${repository.changes.length - 20} more`);
  }
  console.error("Commit or remove the intended changes in a focused branch, then rebuild.");
  process.exit(1);
}

for (const manifestArg of manifestArgs) {
  const manifestPath = resolve(repoRoot, manifestArg);
  let payload;
  try {
    payload = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    console.error(`Deploy blocked: cannot read ${manifestArg}: ${error.message}`);
    process.exit(1);
  }

  const errors = validateReleaseManifestProvenance(payload, repository);
  if (errors.length > 0) {
    console.error(`Deploy blocked by ${manifestArg}:`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error("Rebuild the release from the current clean commit.");
    process.exit(1);
  }

  const artifactNames = releaseArtifactNames(basename(manifestPath));
  if (artifactNames.length === 0) {
    console.error(`Deploy blocked: unsupported release manifest ${manifestArg}.`);
    process.exit(1);
  }

  for (const artifactName of artifactNames) {
    const artifactPath = resolve(manifestPath, "..", artifactName);
    let artifactSource;
    try {
      artifactSource = await readFile(artifactPath, "utf8");
    } catch (error) {
      console.error(`Deploy blocked: cannot read ${artifactName}: ${error.message}`);
      process.exit(1);
    }

    const artifactErrors = validateBundleRuntimeConfig(artifactSource);
    if (artifactErrors.length > 0) {
      console.error(`Deploy blocked by ${artifactName}:`);
      for (const error of artifactErrors) {
        console.error(`  - ${error}`);
      }
      console.error("Rebuild the release with the required VITE_* environment.");
      process.exit(1);
    }
  }
}

console.log(
  `Release source verified: ${repository.sourceCommit} (${repository.sourceBranch}), working tree clean.`,
);

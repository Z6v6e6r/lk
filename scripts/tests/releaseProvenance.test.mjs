import test from "node:test";
import assert from "node:assert/strict";
import { validateReleaseManifestProvenance } from "../lib/release-provenance.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";
const repository = {
  sourceCommit: commit,
  sourceBranch: "codex/main-stabilization",
  sourceDirty: false,
  changes: [],
};

test("accepts a clean manifest built from current HEAD", () => {
  assert.deepEqual(
    validateReleaseManifestProvenance(
      {
        version: "20260725T120000Z",
        sourceCommit: commit,
        sourceBranch: repository.sourceBranch,
        sourceDirty: false,
      },
      repository,
    ),
    [],
  );
});

test("rejects a manifest produced from dirty source", () => {
  assert.match(
    validateReleaseManifestProvenance(
      {
        sourceCommit: commit,
        sourceDirty: true,
      },
      repository,
    ).join("\n"),
    /dirty or unknown source tree/,
  );
});

test("rejects a manifest built from another commit", () => {
  assert.match(
    validateReleaseManifestProvenance(
      {
        sourceCommit: "fedcba9876543210fedcba9876543210fedcba98",
        sourceDirty: false,
      },
      repository,
    ).join("\n"),
    /current HEAD/,
  );
});

test("rejects a legacy manifest without provenance", () => {
  const errors = validateReleaseManifestProvenance(
    {
      version: "legacy",
    },
    repository,
  );

  assert.equal(errors.length, 2);
});

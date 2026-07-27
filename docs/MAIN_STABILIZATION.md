# Main stabilization and clean-release workflow

## Goal

`main` must be a reproducible source of a deployable release. A working
production hotfix is not considered recovered until its source, regression
test, release provenance, and rollback path are recorded in Git.

Do not repair `main` by committing an accumulated dirty worktree or by merging
a broad WIP branch.

## Recovery sequence

1. Freeze the dirty checkout. Do not switch branches, reset, clean, stash, or
   run a broad deploy from it.
2. Create and verify a recovery set outside the repository:
   - a complete `git bundle`;
   - `git diff --binary --full-index`;
   - an archive and NUL-delimited list of untracked files;
   - refs, status, diff stat, and SHA256 checksums.
3. Fetch `origin` and create a separate worktree from `origin/main`.
4. Run baseline checks before moving any old change.
5. Move one logical change at a time into a focused branch and commit.
6. Re-run the relevant gates after every change.
7. Deploy only a clean commit whose SHA is present in the release manifest.

## Change classification

| Class | Meaning | Action |
|---|---|---|
| Production-proven | Deployed and verified through API/browser/runtime evidence | Recover first with source and regression test |
| Local-proven | Focused checks pass, but no production proof exists | Keep in a separate candidate branch |
| Incomplete | Intent, result, or dependencies are unclear | Leave in quarantine |
| Generated/diagnostic | Builds, dumps, full snapshots, temporary reports, browser artifacts | Regenerate or archive; do not transplant as source |

When a file contains several unrelated changes, do not copy the entire file.
Re-implement or stage only the hunks belonging to the current contract.

## Required release gates

At minimum:

```bash
npm ci
npm run build
npm run test:release-provenance
npm run release:preflight
```

Run `npm run lint` and the affected feature tests as well. A pre-existing
baseline failure must be recorded explicitly and must not be hidden by a new
change.

`release:preflight` rejects:

- tracked changes;
- untracked files;
- manifests produced from a dirty source tree;
- manifests built from a commit other than current `HEAD`;
- old manifests without Git provenance.

Every generated release manifest contains:

- `sourceCommit` — full source commit SHA;
- `sourceBranch` — source branch at build time;
- `sourceDirty` — whether source changes existed at build time.

All `deploy:*` and `package:upload:*` commands run the same guard automatically.

## Node-RED rule

For LK Games and referral flows, the current live flow on `lk-primary-147` is
the preimage. Before generating release imports:

1. pull `/root/.node-red/flows.json`;
2. record and verify its SHA;
3. apply source functions and patch scripts;
4. build and validate modular imports;
5. preserve a dated live backup;
6. verify the affected API and browser flow after rollout.

Do not recover Node-RED by copying an old full-flow JSON from the quarantine
worktree.

## Stabilization acceptance criteria

`main` is ready only when:

- a clean checkout installs from the lockfile;
- production and development bundles build;
- required tests pass;
- remaining baseline failures are explicitly enumerated;
- Node-RED artifacts are built from a verified live preimage;
- release manifests contain the deployed Git SHA;
- production postchecks and rollback instructions are recorded.

## Change ledger template

| Change | Source files | Production evidence | Tests | Decision |
|---|---|---|---|---|
| Short issue identifier | Exact authored files, not generated output | Release/flow SHA and postcheck | Commands and results | recover / candidate / quarantine |

Current production inventory:
`docs/PRODUCTION_RECOVERY_LEDGER_2026-07-26.md`.

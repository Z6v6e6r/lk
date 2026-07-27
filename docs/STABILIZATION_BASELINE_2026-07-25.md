# Main stabilization baseline — 2026-07-25

This file records the starting evidence for rebuilding a reproducible `main`.
It is not a declaration that the branch is production-complete.

## Source state

- Quarantine checkout branch: `dev`
- Quarantine HEAD: `ccc387575f7d7665481a03a8502407706c968ab2`
- Clean baseline branch: `codex/main-stabilization`
- Clean baseline commit: `e083017656fd097dbef9ea5269a42e8910e8d709`
- Baseline source: freshly fetched `origin/main`
- Divergence at audit time: `dev` had 2 commits not in `origin/main`;
  `origin/main` had 1 commit not in `dev`
- Dirty quarantine inventory: 129 tracked changes and 742 untracked files
- Tracked diff size: 37,599 insertions and 13,703 deletions

## Recovery set

A local recovery set was created before any stabilization work:

- complete Git bundle;
- full-index binary tracked patch;
- archive of all 742 untracked files;
- refs, porcelain status, diff stat, and untracked file list;
- SHA256 checksum manifest.

The recovery set was verified with `git bundle verify`, `gzip -t`, archive entry
count, and reverse `git apply --check`. It is stored outside the repository and
must be preserved until every required change has either been recovered or
explicitly quarantined.

## Baseline checks

| Check | Result |
|---|---|
| `npm ci` | PASS, 330 packages installed |
| `npm run build` | PASS for prod and dev bundles |
| MAX Node-RED regression test | PASS, 3/3 |
| `git diff --check` | PASS |
| `npm run lint` | FAIL, 1,142 errors and 18 warnings |

The lint failure predates stabilization work. Major sources include Node-RED
function bodies parsed as standalone modules and tracked content under `tmp/`.
It must be reduced in explicit baseline commits; new work must not silently add
to it.

## Next recovery order

1. Inventory production release and live Node-RED flow SHAs.
2. Map production-proven changes from the quarantine checkout.
3. Recover backend contracts and tests before frontend consumers.
4. Recover frontend behavior in focused commits.
5. Regenerate release and Node-RED artifacts from canonical source.
6. Run browser/API/runtime postchecks and record rollback evidence.

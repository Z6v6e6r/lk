# Merge-owner coordination

Use one user-designated merge-owner and one dedicated linked worktree for `main`.
Task worktrees remain on `codex/*` or `agent/*` branches. Before the first edit,
run `npm run governance:worktree:check` from the clean task worktree. The primary
checkout is never a task workspace. Read-only investigation can precede this check.

## Claim and verify

After an authorized fresh fetch, record the full `origin/main` SHA and tree,
the PR head SHA/tree, CI runs, review findings and unresolved threads. The guard
does not fetch or verify GitHub CI; matching local refs alone do not prove freshness.
The linked `main` worktree must be clean and exactly match that frozen main.

```text
npm run governance:main-owner:claim -- --owner <task-id> --expected-main-sha <sha> --expected-main-tree <tree>
npm run governance:main-owner:verify -- --owner <task-id>
```

Preserve the claim's returned `leaseId` with the review evidence. Verify immediately
before each separately authorized Ready/merge boundary and re-read the remote main
and PR head. Any drift, failed gate or unresolved finding stops that boundary.
The guard never executes Git integration, push, PR operations or deployment.

## Completion, drift and interrupted operations

An ordinary merge changes HEAD and therefore makes the old `verify` fail. This is
expected. Read back the merge parents/tree and required CI, record SUCCESS,
ABORTED or BLOCKED_POST_MERGE, and confirm that no operation remains in flight.
Release only that generation from its claiming worktree:

```text
npm run governance:main-owner:release -- --owner <task-id> --lease-id <lease-id>
```

Release checks owner, generation and worktree, but deliberately permits HEAD drift
and dirty state so an aborted attempt cannot deadlock ownership. Release does not
approve the dirty state, another attempt or a push. Freeze and claim anew before
another boundary. A new claim requires local main to equal origin/main; any pending
local integration requires the separately authorized reconciliation/push procedure.

The common Git directory contains `codex-main-owner-v1.json`. Claim/release are
serialized by `codex-main-owner-v1.json.mutation-lock`. Publication is no-clobber;
duplicate release cannot remove a newer generation. Neither marker has a timeout.
An interrupted mutation remains blocked until the user-directed owner investigation
confirms no active process and authorizes recovery. Never delete a marker on age
alone, silently steal it or invent another owner's identity.

## Server-side enforcement remains separate

This guard coordinates cooperating processes in one clone. The owner ID and lease
ID are non-secret labels, not authentication. A process with filesystem access can
bypass it, and other clones do not share it. CI tests the guard and runs community
performance regressions on both PR heads and pushes to main; push CI runs after a
push and cannot prevent that push.

Before claiming merge governance is enforced, separately authorize, configure and
read back GitHub rules requiring PRs, the `LK1 exact-head enforcement gate` check,
resolved review threads, current base compatibility and an appropriately restricted
bypass list. GitHub actor-based rules alone cannot distinguish Codex tasks sharing
one account. Exclusive task ownership still requires coordination or separate
restricted credentials. Do not change those settings as part of using this tool.

Historical direct pushes remain historical violations; a new guard or a green test
does not retroactively validate them. Deploy, runtime activation, flags, Node-RED,
Mongo and provider actions retain their own explicit authorization boundaries.

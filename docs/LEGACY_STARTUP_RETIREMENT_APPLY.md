# Legacy retirement: reviewed application and forward recovery

Status: development/rehearsal only. No merge, deploy, restart or production mutation
is authorized by this change. HTTP diagnosis remains separate. This mechanism removes
exactly the approved 14-node cohort described in [the retirement scope](LEGACY_STARTUP_RETIREMENT.md).
It does not modify credentials, retained nodes or their order, replay messages, or
test providers. The existing exact-graph validator continues rejecting removals.

## Approval and operational prerequisites

A future application needs an explicit decision approving the source commit, exact
contract SHA256, machine/runtime fingerprint, original PM2 PID/restart count, removed
cohort and execution window on `lk-primary-147`. The operator must acknowledge one
full PM2 restart of the shared Node-RED process: a brief interruption and retained
nodes' normal startup effects are possible. This is not a modified-nodes editor
deploy. Confirm readiness endpoints and passive observation criteria before approval;
do not use real email, Telegram messages or workflow writes as probes.

Reserve an exclusive writer window through completion or owner reconciliation.
Freeze native editor deployments and other writers; ensure cooperating release tools
use the shared flock and understand the retirement lease. The runner cannot enforce
an atomic compare-and-swap against a noncooperating editor/root writer. No automatic
ACL, credential, routing or settings change is part of this procedure. A process or
settings change invalidates the target pins; do not override them.

Before approving a real packet, prove that the configured PM2 entrypoint/wrapper,
startup guards and active-flow tooling load the published candidate and cannot
regenerate/restore the original flow on restart. The fingerprint pins executable
and cwd paths, command-line bytes and settings bytes; it does not hash arbitrary
wrapper/entrypoint JavaScript bodies. If that topology is incompatible or uncertain,
stop application and prepare a separately reviewed integration. No production read
or startup-tool change is performed as part of this PR.

## Prepare the private packet

1. Use a clean, reviewed, pushed checkout. After separate authorization, pull a fresh
   live preimage into a **new private external workspace** using the existing
   `nodered:modular:pull-147` procedure and verify its origin with
   `nodered:modular:verify`. Do not rebuild from a repository snapshot. Keep source,
   candidate and full runtime readbacks out of git, PR text, terminal output and logs.
2. Record the complete source byte SHA256 and original PM2 online PID/restart count.
   Pin the SHA256 of `/etc/machine-id` bytes and the runtime fingerprint used by the
   runner: SHA256 of JSON with keys, in order, `executable`, `cwd`, `argsSha256`,
   `settingsSha256`; values are `/proc/PID/exe`, `/proc/PID/cwd`, SHA256 of raw
   `/proc/PID/cmdline`, and SHA256 of `/root/.node-red/settings.js`. Collect only the
   safe hashes/identity evidence; do not export command arguments or settings bodies.
3. Call `prepareLegacyStartupRetirementRelease` from
   `scripts/prepare_legacy_startup_retirement_release.mjs` offline. Supply source
   bytes, separately reviewed `expectedSourceSha256`, unique `deploymentId`, target
   `{hostAlias:'lk-primary-147', machineIdSha256, runtimeFingerprintSha256, pid,
   restartCount}`, and integer epoch-ms `preparedAtMs`/`validUntilMs` at most 30 minutes
   apart. Never pass synthetic `bindings` in a real packet. The composer applies the
   AST dependency gate, all 14 full preimage pins and exact retained-node/order check.
   Review the resulting hashes and removal receipt. The server's dependency-free
   validator relies on this offline AST review of the exact approved source digest.
4. Preserve returned `candidateBytes` as `candidate.flow.json` and `contractBytes`
   as `contract.json`; approve the SHA256 of the **exact contract bytes**. The
   contract binds the whole source, candidate, target, time window and all five
   runner source files enumerated by `RETIREMENT_SOURCE_FILES`. Stage those exact
   reviewed files under `scripts/`, preserving their repository-relative subpaths.
   No TypeScript package or business modules are needed on the server.
5. Future staging must use a new canonical root-owned directory matching
   `/root/.node-red/.padlhub-reviewed-flow-stage-YYYYMMDDTHHMMSS+ZZZZ-NNN`.
   Stage/nested directories are mode 0700; all packet/runner files are root:root
   mode 0600, regular single-link files without symlinks. Parent must not be group
   or world writable. Do not overwrite an existing attempt. Do not stage separate
   credential stores or new secrets. The private whole flow may already contain
   legacy literals and must receive the same protected custody as sensitive data.
   Private backup storage and enough disk space must be available.

Preparation only returns buffers and a plan; it never stages or applies anything.
The commands below are future operator templates, not commands executed by this PR.
`STAGE` and `CONTRACT_SHA` refer to the reviewed packet above, not user-supplied URLs.

```sh
node "$STAGE/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs" preflight "$STAGE" "$CONTRACT_SHA"
node "$STAGE/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs" status "$STAGE" "$CONTRACT_SHA"
```

The CLI requires root, execution from the reviewed stage and the shared
`.padlhub-reviewed-flow-deploy.lock` flock (conflict exit 75). It has no environment
variable to skip serialization. Preflight/status do not publish flows, create a
lease or restart PM2; CLI locking may create the coordination lock file. Direct
factory use is for isolated tests; production callers must use the CLI.

## Apply and verify after explicit authorization

```sh
node "$STAGE/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs" apply "$STAGE" "$CONTRACT_SHA" RETIRE_14_LEGACY_NODES_147_FORWARD_ONLY
```

The literal is an operator guard, not a substitute for approval. Preflight rejects
an existing attempt/lease, expiry, wrong machine/process/runtime, drifted source,
candidate, contract or runner files, and unsafe custody. Before publication the
runner durably saves source/candidate/contract and `journal.json` under root-private
`.padlhub-reviewed-flow-backups/retirement-CONTRACT_SHA/`. The source backup is for
investigation only, never restoration. A valid attempt-start timestamp keeps an
attempt abortable even when slow backup/fsync work exhausts the start window.

A v2 `phase:applying` retirement lease stays active without automatic expiry.
Ordinary helper apply/rollback cannot adopt it; the ordinary rollback also refuses
a retirement backup contract without a lease. Never relabel a contract, delete the
lease, invoke old rollback scripts or copy the source backup onto the live flow.
Deployers carrying older helper code are excluded by the exclusive writer window.

The runner writes durable publication intent, atomically publishes candidate bytes,
then writes `RESTART_INTENT` **before** its only PM2 restart invocation. Any failure
retains artifacts/custody for reconciliation. A successful PM2 command alone is not
closure: candidate disk bytes and exact new online PID/restart count are checked,
then the operation enters SOAKING with the lease still active.

After at least 15 minutes of passive checks, obtain a fresh full native runtime-flow
readback and readiness result through the established protected read-only path.
Write a root:root 0600 single-link `postcheck.json` in this attempt's backup directory:

```text
{ observedAtMs: <integer epoch ms>, contractSha256: <approved hash>,
  pid: <current online PID>, restartCount: <current PM2 count>,
  readiness: "ready", runtimeFlow: <full native flow array> }
```

This file contains private flow data; never print or upload it. The operator attests
readiness/acquisition time; the runner does not call the native endpoint itself.
It independently canonical-hashes the full readback against candidate and checks
contract/process identity. Absence of startup warnings or a boolean “nodes absent”
is insufficient. The observation must be after the soak and at most 30 seconds old,
including the final check after durable completion and immediately before lease
unlink. Acquire a fresh proof if filesystem work or interruption makes it stale.

```sh
node "$STAGE/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs" finish "$STAGE" "$CONTRACT_SHA" RETIRE_14_LEGACY_NODES_147_FORWARD_ONLY
```

Only verified COMPLETE releases the lease. Preserve the private journal and
postcheck receipt; report hashes/status only. No automatic backup cleanup is done.

## Recovery decision table

Begin with read-only `status`; preserve artifacts and the writer freeze. The same
approved packet/runner must remain intact. Each mutating recovery command requires
explicit authority for that action and target; preparation of this PR grants none.

| Durable state and evidence | Permitted next step |
| --- | --- |
| No journal/lease and source unchanged | Preflight a new packet. If a partial backup directory exists, preserve it for owner review; do not overwrite or blindly retry. |
| PREPARED before lease publication | Abort while source and original runtime still match; or owner review of the incomplete attempt. Recovery does not invent a missing lease. |
| PREPARED/PUBLISH_INTENT, matching lease, source unchanged | Before expiry, approved `recover` can publish forward. `abort-before-publication` can release custody without writing source/restarting, even after expiry. |
| PREPARED/PUBLISH_INTENT, candidate already on disk, original process unchanged | Approved `recover` validates candidate and proceeds to its first restart intent. It never republishes source. |
| RESTART_INTENT, exact online new PID and counter +1 | Approved `recover` reconciles lost acknowledgement and begins a fresh 15-minute soak; it never repeats restart. |
| RESTART_INTENT, old PID, offline process, count drift or ambiguous outcome | Hold lease for owner decision. No automatic restart retry. A reviewed restart-only forward recovery may need a separately prepared change; this runner deliberately does not implement an ambiguous retry. |
| SOAKING, exact candidate/process | Approved `recover` reports state without restart; finish requires a fresh protected postcheck after soak. |
| Source reappears after restart, foreign flow/lease, custody or identity drift | Stop for owner reconciliation. No overwrite, source restoration, lease deletion or generic rollback. |
| COMPLETE journal with lease still present | Approved `finish` revalidates a fresh full postcheck before releasing; stale saved proof cannot release custody. |
| COMPLETE without lease | `finish` can return the cached receipt only with unchanged disk/process and saved postcheck hash; it performs no restart. |
| ABORTED, source/original runtime unchanged | Repeated abort is idempotent. Use a newly reviewed packet for any new attempt. |

Future command templates, with the same staged script and authorization literal:

```sh
node "$STAGE/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs" recover "$STAGE" "$CONTRACT_SHA" RETIRE_14_LEGACY_NODES_147_FORWARD_ONLY
node "$STAGE/scripts/nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs" abort-before-publication "$STAGE" "$CONTRACT_SHA" RETIRE_14_LEGACY_NODES_147_FORWARD_ONLY
```

Restoring retired email/counter startup paths could reactivate external writes.
Recovery therefore moves forward with the reviewed candidate or stops for a new
owner decision; the source flow is never an automatic recovery destination. A held
lease can prolong an outage after a failed restart. That availability tradeoff is
intentional and must be accepted before a live application.

## Rehearsal and remaining evidence

```sh
node --test scripts/tests/legacyStartupRetirement.test.mjs scripts/tests/legacyStartupRetirementRelease.test.mjs scripts/tests/reviewedFlowDeploy.test.mjs
```

Tests use synthetic graphs and temporary private files with injected machine/clock/
PM2 adapters: exact-filter contract versus unchanged exact-graph rejection, target
and source closure drift, custody, competing/nonexpiring leases, publication/restart
crashes, backup-time expiry with safe abort, uncertain/lost restart acknowledgement,
offline/extra restart, foreign writes, fresh full-graph proof, completion crashes,
late fsync freshness, own atomic-link residue and ordinary rollback bypass attempts.
CI also runs the modular toolchain and existing shared deployment custody suites.

No test calls providers or uses production credentials. Real PM2/Linux filesystem
behavior, native readback acquisition, writer freeze, production readiness and the
effect of restarting retained startup nodes require separately authorized operational
verification. Passing local tests/CI does not close production P2 findings.

# Guarded MAX SDK activation on primary147

Owner: LK/MAX operations. Audience: release operator. Source behavior is PR364,
merged as `8aca5f369689047468b3e1f6daaa94b7f8fd85dd`. Activation additionally requires
explicit approval of one shared Node-RED stop/start and retaining both MAX contours
paused until a separate queue review. This approval was given on2026-11-12.
No real send, replay, old queue release, provider/DB readback, credential/endpoint
change or new postinstall/PM2 policy is included.

`scripts/nodered_max_activation.mjs` is a focused root-only installer. Its production
CLI fixes userdir `/root/.node-red`, hoisted SDK0.2.2, contrib0.6.1 and exact six
node-identity hashes: two receivers, two senders, two legacy outbox injects. It
rejects extra MAX node types and literal direct MAX API/SDK references in flow
URL/function/initializer/library declarations. Full flow SHA binds other content;
only those six `d:true` flags may differ semantically. The SDK files and43-file JS
closure are pinned to reviewed pre/candidate digests. The helper is a separately
pinned CJS file and is not included in the43 `.js` count.

## Release custody

Build/copy from a clean pushed activation checkout after both independent risk
reviews and required CI. Record its full release SHA and installer SHA. Copy only
installer and three previously reviewed candidate files into a new private root
stage, direct child of the fixed userdir:

```text
/root/.node-red/.padlhub-max-guard-stage-<lowercase-unique-id>/
  installer.mjs
  client.candidate.js
  messages.candidate.js
  max-response-guard.cjs
```

Stage mode0700, files0600, root ownership, no aliases/hardlinks. Do not export raw
flows, backups, env, logs or journal token. The CLI exports only safe packet hashes,
counts, enums, process identity and timestamps. An external controller retains
safe JSON evidence and uses the existing direct SSH/SOCKS route without modifying
network configuration.

Set `PADLHUB_MAX_ACTIVATION_SOURCE_COMMIT` to the pushed activation SHA for every
CLI action. No PM2 environment is updated by this variable. The wrapper acquires
exactly the common reviewed-flow flock. It refuses active, editor, unknown or
malformed leases; only fully valid expired format2 `soaking` custody is reclaimed.
The600-second wrapper budget covers bounded PM2 commands and boot readiness; a
transport timeout is not proof that server-side work stopped. Inspect custody,
never blindly rerun apply after losing acknowledgment.

## Prepare, apply, observe

```sh
node installer.mjs prepare /root/.node-red/.padlhub-max-guard-stage-<id>
node installer.mjs apply /root/.node-red/.padlhub-max-guard-stage-<id> <packet-sha>
node installer.mjs observe /root/.node-red/.padlhub-max-guard-stage-<id> <packet-sha>
```

Prepare is read-only. Save exactly its safe `packet` object as root0600
`stage/packet.json`; retain the supplied semantic `packetSha256`. Apply admits the
packet only within5minutes and rechecks fresh flow/SDK/settings/credentials/package,
machine, PM2PID/definition and source identity. It refuses PM2 watch/cron policies
instead of changing them.

Apply creates durable private flow/two-SDK backups and a generation journal under
stage/transaction. It publishes non-expiring `applying` custody BEFORE stop.
`STOPPING` is journalled before exactly one PM2stop; missing acknowledgment is
reconciled only by stopped/PID0 plus old-process absence. No target files are
published while active. It writes the six-node paused flow, then SDK helper,
messages and client, using same-directory atomic rename and file/directory fsync.
All expected bytes, caller resolution, closure and protected config hashes are
checked before a single PM2start of the existing saved definition.

A fresh PID/start timestamp is required; stop/start may preserve or increment the
PM2 restart counter by one. No extra restart is used to obtain a counter value.
Readiness requires a protected stdout cursor captured before stop and a new boot
`Welcome to Node-RED -> Starting flows -> Started flows`, with no startup-failure
marker. It is checked before verification and during soak. These checks do not
call a business endpoint or provider.

Only successful readback enters15-minute `soaking`. `observe` binds the same packet,
installer, machine, generation, flow, SDK, protected config and exact PM2 identity.
After successful complete soak it retains private receipt and releases only its
own shared lease. All six MAX nodes remain disabled. No unpause command exists.
This establishes installed artifact/resolution/new-process/readiness evidence;
natural MAX error-path observation remains false while consumers are paused.
It does not establish global absence of all provider traffic from unrelated apps.

## Failure and recovery boundary

Any interrupted/unknown phase retains private journal. No automatic second start,
SDK rollback or enabled-graph restore is implemented. After stop/partial commit,
keep the process stopped and perform owner-guided exact-byte forward recovery.
A missing start acknowledgment is accepted only if its one start produced the
expected healthy process/readback. Unhealthy start or soak drift quarantines with
stop only when generation, full paused candidate/closure/config and process
definition still belong to this transaction. Foreign state is not stopped or
overwritten. Owned custody is made non-expiring before quarantine effects.

An error after soaking publication also restores owned `applying` custody before
quarantine, avoiding expiration of an incomplete operation. If filesystem custody
itself cannot be made durable, do not assume cancellation, rollback or safety;
retain evidence and investigate in-flight state. Do not delete a marker merely
because it is old or reapply the whole transaction.

The install is node_modules-only. npm reinstall can erase it. Preserve the receipt
and re-attest/reapply through a reviewed mechanism after future package changes.
Settings, credentials, userdir/SDK package files, hooks and provider origin remain
unchanged. Monitoring classifier changes and old-queue reconciliation are separate.

## Tests

```sh
node --test scripts/tests/maxActivation.test.mjs
```

Synthetic filesystem/PM2 tests cover happy path, exact six-node scope, both lost
acknowledgments, unchanged restart counter, stop uncertainty, each publication
failure, foreign state, malformed/active lease, packet binding, watch/cron denial,
startup readiness/failure, post-soak-publication failure and soak quarantine.
Transport and PM2 are mocked; no activation test sends are performed. Existing
MAX workflow runs this suite separately from its unchanged rate-limit suite.

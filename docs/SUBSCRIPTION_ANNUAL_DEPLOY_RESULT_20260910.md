# Annual subscription OFF deployment — 2026-09-10

OFF deployment accepted. The 15-minute soak completed successfully with 20
read-only samples. Final readback at 2026-09-10T05:43:27.250Z confirmed the exact
candidate, stable online PID/restart count, persistent OFF configuration, expired
soak lease and zero canonical annual sentinels. The lease was not manually removed.

Published source: `dd2b9a4b7e4991fd49e753a2cd3ff0ac526b3712`.
Exact-head CI: https://github.com/Z6v6e6r/lk/actions/runs/34438771109 — success.
A parallel task advanced local main during preparation. Deployment used the clean
pinned checkout `/private/tmp/lk-annual-off-deploy-dd2b9a4-20260910`; existing main
and task-branch changes were preserved.

## Installed state

- Host/process: `lk-primary-147`, PM2 `node-red`.
- Before: `5fce9a8d20138e0c28f2bb7d6e950fb1f71b31364af423085e4207e807d8e2d5`.
- Installed candidate: `12ed9b7a70d086f0640a7d0332213b7baf5b02dd5756eebe0317ec0fc611f31b`.
- Graph: 4799 nodes / 219 HTTP inputs; approved 8 changes + 1 addition.
- Confirmed startup: PID 4058767, PM2 restart counter 114.
- Persistent configuration revision 1: common/hub/piter=false;
  raClosed/friendshipClosed=false. Exact nested/top-level ENV and durable dump
  readback matched. Unrelated ENV and normalized process definition preserved.
- Actual Node-RED globals and startup attestation read with the explicitly
  authorized existing admin session. Token remained on the server and was not
  logged/exported. `attestation.valid=true`, all five flags read as false.

## Execution and recovery evidence

The first installation automatically restored the exact source and restarted
successfully after a false-negative postcheck. Installed Node-RED encodes a boolean
context value as `format:"boolean", msg:"false"`; the original local checker
incorrectly expected a JavaScript boolean. Only the operational decoder was fixed;
application candidate/hash stayed unchanged. Seven decoder assertions and an
independent review passed. The second attempt reused the already persisted OFF
configuration without an additional ENV restart and passed readback.

The PM2 publisher was physically rehearsed against an isolated local daemon.
Positive persistence, reuse without restart, and rejection of unrelated persisted
configuration drift before restart passed. The fixture daemon was stopped.
Protected backups of PM2 definition/dump/previous dump backup were retained.
Existing dump backup permissions were narrowed from 0644 to 0600 before saving.
Both candidate attempts used the existing deployment lock and guarded operator.
No lease was manually removed. The operator released the failed attempt's lease
only after its successful rollback; the successful apply created a new 900-second
soak lease ending `2026-09-10T05:41:57.454Z`.

## Read-only API evidence

At `2026-09-10T05:30:32.979Z`, public HTTPS status reads succeeded for all four
products; booking CORS OPTIONS returned 204. Primary TLS ingress also passed.
An initial local Node fetch connect timeout was followed by successful curl
verification. This transport failure was not interpreted as a runtime defect.

| Product | canPurchase | Displayed remaining / total | Price RUB |
| --- | --- | --- | --- |
| RA | true | 97 / 150 | 23800 |
| Friendship | true | 133 / 150 | 9800 |
| Annual HAB | false | 10 / 10 | 98000 |
| Annual Piter | false | 358 / 400 | 19800 |

These are observed legacy-mode displays, not the requested new quota activation.
RA/Friendship admission remains as before. HAB/Piter annual sales remain closed.

## Scope and remaining work

The deployment operator and deployment checks executed no ledger seed,
reconciliation, activation, purchase/confirm/refund or Viva mutation. Both canonical annual sentinels were absent before candidate startup.
OFF flags do not stop normal background reconciliation; no claim is made that
ordinary production traffic performs zero database writes.

Fresh provider/ledger reconciliation and activation remain separate. Target rules
are preserved: RA 10 new daily seats with prior operations retained; Friendship 7 total per day including paid and active pending;
HAB 98000 RUB and 1/day with all approved paid history counted; Piter initially
48/100 with the approved adjustment. Both annual products activate next day.
Historical snapshots must not be used as current opening evidence.

Private receipts, helpers, rollback evidence and staged operator closure are under
`/private/tmp/lk-annual-history-package-20260910/deploy-execution/` and protected
server stage/backups. Raw flow/ENV/session data must not be committed to Git.

Read-only readiness check for the next stage found that the default server Mongo
package is 3.7.4 and lacks `BSON.EJSON.stringify`; the approved source lock pins
MongoDB Node driver 7.2.0 (not a database-server upgrade). The maintenance operator must therefore use a separately prepared,
verified dependency environment before ledger writes. Its permanent publication
`/root/.node-red/.padlhub-annual-history/release.json` is absent; the reviewed
17-file closure is staged only. No maintenance command was run and no dependency
was installed during this deployment. This does not affect Node-RED serving the
OFF candidate, but remains a concrete prerequisite for reconciliation/activation.


## Final checks and recorded changes

Production changes: reviewed flow publication and Node-RED restart through the
existing guarded operator; one persistent PM2 sales configuration key; protected
PM2 dump/backup persistence. Application code was not changed after the published
source. Operational checker/publisher helpers and raw receipts stay private.
Report changes: this document and WORKLOG, in the preserved task branch only.

Evidence reused: successful exact-head CI for dd2b9a4, previous candidate graph,
compatibility and custody reviews. Evidence executed in this stage: isolated PM2
positive/negative/reuse rehearsal, decoder positive/negative tests, staged file
hash checks, authenticated runtime flags/attestation, internal and public HTTPS
status/CORS checks, full soak and final persistence/ledger readback. Independent
release and payment-safety reviews passed within their stated scope.

Not executed: real user purchase/payment, provider writes, ledger maintenance or
activation, browser end-to-end purchase, permanent maintenance publication or its
Linux dependency/transaction rehearsal. Node-RED uses Node v22.23.2; the separate
maintenance dependency package remains necessary. The final dump and dump backup
both have mode0600. No new main merge or push was performed for this report.

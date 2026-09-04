# LK1 managed subscription DEV environment contract

## Result of the 2026-09-02 read-only audit

The managed subscription router now selects runtime-context, entitlement
reserve/confirm/release, and first-use activation from one server-owned
environment binding. PROD is exact-origin HTTPS; DEV is exact loopback HTTP.
Both reject userinfo, query, fragment and path drift and require the exact
environment allowlist. Browser
fields cannot select an upstream URL. Managed HTTP commands disable redirects
and carry a bounded timeout.

DEV rollout is additionally default-off behind exactly two server-owned
`clientSubscriptionId` UUIDs. Empty configuration enables none; malformed
configuration fails closed. PROD never reads or depends on the DEV canary list.
The tracked production functions are baked to expect `PROD`; a DEV candidate
rewrites that immutable expectation to `DEV`, removes the managed production
CUP binding, and rejects any opposite environment global. The managed gateway
also repeats the environment, origin, and canary checks immediately before a
Viva booking POST.
The split CREATE path now completes the authoritative Viva purchase-date read,
CUP runtime/policy validation, atomic entitlement reservation, and durable local
`PRECREATE_ATTEMPTING` binding before the Viva exercise POST. Missing/conflicting purchase
evidence, CUP timeout, policy mismatch, and entitlement rejection therefore
cannot leave an empty Viva game. A definitive exercise-create rejection releases
the exact entitlement before the request returns. Ambiguous provider outcomes
remain fail closed in `PRECREATE_ATTEMPTING`; retry cannot emit another CREATE,
and an exact 409 conflict is adopted only through the normal exercise readback.

## Frozen DEV source evidence

The read-only capture from
`lk-reserve-89:/root/.node-red/flows.json` produced SHA-256
`52c1b510b40f96de7bf1f9991a17454f79b560eaf002cc0c60147065b31c33e3`:

- 922 nodes, 2 HTTP routes, 11 tabs;
- zero broken wires and zero broken links;
- no enabled `LK Games` tab;
- neither required subscription router target exists;
- zero enabled semantic target duplicates because the targets are absent;
- two non-loopback Mongo configuration nodes;
- HTTP request binding and effective DEV-only Mongo database custody are not
  proven.
- five production/shared endpoint families remain in the tracked router
  sources: Viva Admin, Viva end-user, Keycloak prod realm, SERV2, and the legacy
  CUP pricing default.

The host flow therefore is not accepted as an LK1 DEV source. The checked-in
binding is `BLOCKED_DEV_FLOW_TARGET_ABSENT`, `installAllowed=false`, and
`environmentIdentityVerified=false`.

The reserve HTTPS route exposes only the separate subscription-test surface;
the installed DEV CUP service contains runtime-context and activation code but
does not expose the complete runtime-context + entitlement
reserve/confirm/release + activation contract through a dedicated HTTPS
origin. Consequently the DEV runtime trust anchor remains `null`.

## P1 source remediation

- Managed split CREATE uses distinct `PRECREATE_RESERVING` ->
  `PRECREATE_RESERVED` -> `PRECREATE_ATTEMPTING` transitions. Only the exact
  persisted CUP reservation and provider-attempt CAS can
  promote to `PENDING_CONFIRMATION` for the actual Viva exercise. Regression
  tests assert zero Viva/Mongo writes for purchase-date, CUP runtime, and policy
  failures, and assert that the exercise POST appears only after the reservation.
- The candidate builder freezes and replaces the exact reachable `Prepare
  subscription booking`, `Prepare split game payment`, managed router, split
  join prepare, split router, and finalizer preimages.
  Their combined postimage endpoint audit allows only the dedicated loopback
  Viva/SERV2/Keycloak/CUP fixture origins. Dynamic CUP/token overrides are
  removed in the DEV postimage, credential-bearing redirects are disabled, and
  both reachable HTTP request nodes plus their return wiring are independently
  hash-attested.
- Snapshot and build validation now inventory `mongodb4-client` and the exact
  router output -> `mongodb4` (`find`, `insertOne`, `updateOne`) -> router graph.
  All three nodes must use one hash-attested client in exact URI mode resolving
  to `127.0.0.1:27030/dev-lk1-subscription-canary`, with empty advanced
  options, no serialized credentials/TLS options, and a separate SHA-attested
  empty Node-RED credential store. Fields-mode clients are rejected. Legacy
  `mongodb` counts remain only additional drift evidence.

The three documented P1 source blockers are closed. The historical provisioning
contract remains byte-for-byte `STOPPED_BOOTSTRAP_AUTHORIZED` and authorizes no
candidate, install, or service start. A separate v2 source-only contract permits
only deterministic local generation and candidate publication under a temporary
workspace; `installAllowed=false` remains unchanged. No source result is
host/runtime evidence, the DEV trust anchor is null, and the audited shared-host
targets are absent.

## Release custody

- `pull_nodered_dev_source_readonly.sh` can only read the fixed reserve host and
  writes the snapshot under an external `/private/tmp` or `/tmp` workspace. It
  labels this shared-root capture `shared-host-audit-only`; the DEV builder
  accepts only `dedicated-dev-target` at the separately pinned service user-dir.
- `inspect_lk1_subscription_dev_snapshot.mjs` mechanically records source SHA,
  counts, graph health, target identities/preimages, semantic duplicate count,
  both exact HTTP request wirings, `mongodb4-client` effective identity and
  credential-store evidence, each managed `mongodb4` operation edge, and a
  derived whole-flow network configuration inventory; function bodies are
  audited after builder composition. The candidate permits exactly the two pinned
  dynamic HTTP nodes and six pinned producer/output edges; extra request nodes
  or senders are rejected before publication.
- `generate_lk1_subscription_dev_offline_source.mjs` requires a clean exact
  `origin/main` commit and reconstructs every function body from that commit.
  `prepare_lk1_subscription_dev_candidate.mjs` requires this exact offline source,
  the source-only authorization contract, exact function
  preimages, zero graph damage, proven HTTP binding, and independently proven
  DEV-only Mongo custody. It independently reproduces the snapshot endpoint
  inventory, patches and audits every reachable function that
  can select an upstream URL, including the prepare node, and rejects any
  whole-flow postimage retaining an unapproved or malformed endpoint. On success it writes a distinct DEV candidate
  and manifest exclusively into a new external workspace; existing artifacts
  are never overwritten.
- `verify_lk1_subscription_dev_install.mjs` validates a manifest against the
  frozen bound source/candidate and target. With the current blocked binding it
  always stops. It performs no import.
- The production builder reads an explicitly `environment=PROD` binding and
  rejects a DEV manifest. Its candidate binding remains
  `UNBOUND_AFTER_ROUTER_AMENDMENT`; no DEV digest is copied into it.

The source-remediation stage performed no Node-RED import, service restart,
runtime-global mutation, Viva write, Mongo write, deployment, or activation.
The subsequent, separately authorized stopped host installation is recorded below.

## Dedicated target provisioning contract and stopped bootstrap

A second read-only capture at `2026-09-02T17:12:36Z` returned the same shared
flow SHA and again found no LK Games target. Host topology inspection also found
only the shared root-owned Node-RED process at `0.0.0.0:1880`, shared user-dir
`/root/.node-red`, the existing subscription-shadow service at
`127.0.0.1:3036`, its Mongo listener at `127.0.0.1:27029`, and an nginx
`/api/` route that proxies to production. None is an acceptable base for this
DEV target.

`lk1_subscription_dev_provisioning_contract.json` records the narrowly scoped
`STOPPED_BOOTSTRAP_AUTHORIZED` authorization. It defines the physically distinct
target below; only its identity, locked unit files and pinned program dependencies
have been installed, not an executable DEV application flow:

- Unix user/group `lk1-subscription-dev`;
- systemd unit `lk1-subscription-dev-nodered.service`;
- user-dir `/srv/lk1-subscription-dev/node-red`;
- loopback-only Node-RED listener `127.0.0.1:1882`;
- separate fixture Mongo `127.0.0.1:27030`, database
  `lk1_subscription_dev_fixture`, and dbPath
  `/srv/lk1-subscription-dev/mongo`;
- fixture-only CUP/provider/identity listeners on `3037`, `3038`, and `3039`;
- loopback-only network policy with non-loopback egress and production DNS
  disabled;
- candidate publication, install, service start, and ingress separately
  unauthorized/unbound, all managed
  product/canary flags empty, and source,
  candidate, manifest, and host-readback SHA values null.

### Historical stopped-install evidence

The authorized bootstrap completed on `lk-reserve-89` at
`2026-09-02T20:23:18Z`, followed by an independent read-only postcheck:

- installed source commit: `f9c08c0133811876c63bd78dee0a1482690582ca`;
- bootstrap manifest SHA-256:
  `b00ad01a36e41f254fefbaab94358239349a607820a443ffa35e401173ab92bc`;
- authorization contract SHA-256:
  `223f3756056d153684cebd3bd0f69392ec947eacf45f69c2d107f9a8ee0231ff`;
- dedicated user/group and root-owned program/evidence directories created;
- all five units `loaded`, `disabled`, `inactive/dead`;
- no listeners on `1882`, `27030`, `3037`, `3038`, or `3039`;
- service-start marker and `node-red/flows.json` absent;
- no service start, ingress, activation, canary IDs, secrets, or provider/data
  mutations in this bootstrap operation.

The exact Node, Mongo and Node-RED archive hashes matched on host readback.
The root-owned receipt is
`/srv/lk1-subscription-dev/bootstrap-evidence/bootstrap-install.json`.
These are historical stopped-install observations, not current runtime health or
functional UAT evidence. The authorization contract is retained byte-for-byte
because the installed manifest pins it. It is not permission to repeat a host
operation or advance to the next stage.

The later ordinary merge of parent `c4425940efc803268c42a2597e1a8cd6eac2a3a8`
produced integration checkpoint `e71a115ef6ea5b64b23b3e8040182e1423a0da11`.
It changed no installed bootstrap payload bytes. That integration checkpoint
must not replace `f9c08c0` in the historical installed-source evidence.

### Staged execution plan (remaining steps require separate authorization)

1. Re-freeze `origin/main`, PR head/tree, CI, host identity, listeners, units,
   ingress directives, and the shared flow SHA. Stop if any named resource or
   port is occupied or if another deployment owner/lease exists.
2. Create only the dedicated Unix identity and `/srv/lk1-subscription-dev`
   tree. Install separately pinned Node-RED and fixture dependencies without
   reading or copying `/root/.node-red`, `3036`, or `27029` state.
3. Provision the dedicated Mongo/CUP/provider/identity fixtures on their exact
   loopback listeners. Keep systemd egress restricted to loopback. Prove zero
   non-loopback sockets and zero production DNS/API access with fixture-owned
   sentinels before any Node-RED start.
4. Generate a minimal offline DEV source flow in an external workspace; bind
   exact node IDs, route inventory, dependency wiring, and source SHA. Run
   structural, redirect, Mongo4-client, endpoint, and zero-write tests. Do not
   derive it from or merge it into the shared root flow.
5. Build an immutable DEV candidate and manifest with the reviewed source SHA,
   candidate SHA, exact target identity, flags OFF, empty canary list, and
   production binding still unbound. Independent security and release review
   must approve this frozen tuple.
6. Under a separate install authorization, place the stopped candidate into
   the dedicated user-dir, read it back, and require byte-identical source,
   candidate, manifest, and host-readback SHA evidence before starting any
   unit. A mismatch stops without cleanup or substitution.
7. Under a later service-start authorization, start fixture dependencies first
   and Node-RED last while it remains loopback-only and default-off. Prove unit
   identity, listener ownership, route count, graph health, zero production
   connections, and zero fixture writes at idle.
8. A separate ingress review must define a non-shared DEV HTTPS origin and
   exact certificate/routing contract. A later, explicit ingress-execution
   authorization must bind the frozen origin, certificate SPKI SHA, listener,
   and config path; review alone grants no mutation authority. No existing
   nginx `/api/` or shared 443 listener may be reused. Bind the CUP API only
   after the complete managed contract passes strict HTTPS readback.
9. A separate activation authorization may set exactly two server-owned
   `clientSubscriptionId` values only after physical zero-write negative tests.
   Production remains independent and unbound.
10. Rollback removes ingress before listener exposure, stops Node-RED before
    fixtures, preserves evidence/logs, and performs no data deletion without a
    separately approved destructive step.

The historical stopped identity/dependency bootstrap in step 2 is retained as prior
evidence. In this branch, local-only source and candidate preparation for steps 4-5
is reproducible and tested. The source-only authorization
is separate from the historical bootstrap contract: it permits only deterministic
generation and publication below `/private/tmp`, while candidate install, Node-RED
import, service start, unit enablement, ingress, activation, canary IDs, secrets,
and external writes remain unauthorized.

This branch intentionally contains no fresh host-evidence artifact. The source-only
contract fixes `hostPreimage.state=ABSENT` as the future install target contract, not
as a current host observation. A fresh read-only host preflight remains mandatory
before any separately authorized install stage.

The offline generator produces a 23-node isolated source with two HTTP routes, one
credential-free loopback Mongo client, and the exact reviewed function-node
preimages. Its frozen source-base commit may remain an ancestor of the current
`origin/main`; the tooling `HEAD` must contain current `origin/main`, and exact
source/tooling blobs remain independently verified. The publisher binds all reachable
HTTP endpoints to `127.0.0.1`, records
`sourceProvenance=OFFLINE_GENERATED`, `hostPreimageState=ABSENT`, a null rollback
source, and writes readiness last through a private staging directory. The frozen
source/candidate/manifest SHA-256 tuple is:

- source: `bada371662cc4d4a27fca5a1a9335c657dac298bba754f48f9787ac67bfe4722`;
- candidate: `ab73803e90852ebc99cd9b019cf181c9bd402e4737ccde8256cc6da448039fb9`;
- manifest: `f47b1b13aae9e5dd3f4dabf5797afcc61d55d88cc57bcdbec3c139a511c71865`.

The DEV postimage also strips browser-supplied success/failure/base redirect URLs
from both split-payment preparation paths before any provider transaction can be
assembled. Production source defaults are not changed by this DEV-only binding.

This remains source-only evidence. The stopped fixture runtime now implements
synthetic in-memory `managedEntitlement` and `activation`, physically verified on
a fixture-owned local loopback listener. `createJoin` and provider/identity remain
locked, and the candidate truthfully separates `localPhysicalVerified=true` from
`hostRuntimeExposed=false` and `completeManagedContractExposed=false`. No DEV
application candidate has been installed or exercised; steps 6-9 remain separate
future gates with fresh readback and independent review.

### Integration validation limitations

Local runner, bootstrap, provisioning, DEV candidate, critical matrix and DEV
runtime suites pass after the parent merge. The exact-head CI workflow does not
invoke the runner or DEV candidate/provisioning/bootstrap suites, so those remain
local evidence rather than CI evidence.

The v2 receipt contract separates the exact 40-hex Git `sourceCommit` from 64-hex
source/candidate/manifest/readback/served SHA-256 fields. Source-only receipts keep
host readback and served digests null. Neither artifact digests nor the bootstrap
manifest may substitute for Git identity or runtime proof; no active fixture service
is provided by the stopped bootstrap.

An additional 219-test regression run has 217 PASS, one SKIP (the live-router
fixture is absent), and one pre-existing failure in
`vivaServiceTokenCache.nodered.test.ts`: the cleanup fixture lacks a tenant and
is rejected with `legacy_game_tenant_required` before its cached-token assertion.
The same fixture result was reproduced on `1dcc868`, `c442594`, and the merge
HEAD; the cleanup source blob is identical
(`fb7171907ff0691bb5c3500a3d6848b7495362c6`). This is recorded as a separate
baseline failure, not a passing test or a merge regression. No cleanup runtime
or tenant guard was changed to bypass it.

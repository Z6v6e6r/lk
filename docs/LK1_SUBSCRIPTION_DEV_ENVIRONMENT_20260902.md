# LK1 managed subscription DEV environment contract

## Result of the 2026-09-02 read-only audit

The managed subscription router now selects runtime-context, entitlement
reserve/confirm/release, and first-use activation from one server-owned
environment binding. The URL contract is HTTPS-only, rejects userinfo, query,
fragment and path drift, and requires the exact environment allowlist. Browser
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
The split CREATE path repeats the environment/canary preflight before the Viva
exercise POST so a DEV canary cannot leave an empty game behind when the runtime
binding is invalid.

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

## Remaining P1 release blockers

- Split CREATE still creates the Viva exercise before authoritative managed
  purchase-date, CUP runtime/policy, and entitlement evaluation. The flow must
  be reordered so missing/conflicting purchase evidence, CUP timeout, or policy
  pin mismatch cannot follow an exercise write.
- The separate `Prepare subscription booking` function is reachable before the
  managed router and still contains production/shared Viva endpoints. A future
  BOUND builder must include its exact preimage/postimage and the complete
  reachable-path endpoint audit, not only router and split-router sources.
- Mongo custody must inventory `mongodb4-client` configuration and prove exact
  router output -> `mongodb4` node -> clientNode wiring plus effective DEV-only
  URI/database attestation. Counting legacy `mongodb` configuration nodes is
  not sufficient for a BOUND candidate.

These blockers keep `LK1_DEV_ENV_ISOLATION=FAIL`, the DEV candidate builder
blocked, and merge-owner handoff stopped. They do not weaken the current
fail-closed checked-in binding because `installAllowed=false`, the DEV trust
anchor is null, and the audited DEV flow targets are absent.

## Release custody

- `pull_nodered_dev_source_readonly.sh` can only read the fixed reserve host and
  writes the snapshot under an external `/private/tmp` or `/tmp` workspace. It
  labels this shared-root capture `shared-host-audit-only`; the DEV builder
  accepts only `dedicated-dev-target` at the separately pinned service user-dir.
- `inspect_lk1_subscription_dev_snapshot.mjs` mechanically records source SHA,
  counts, graph health, target identities/preimages, semantic duplicate count,
  and sanitized Mongo config preimage hashes.
- `prepare_lk1_subscription_dev_candidate.mjs` requires a fresh (30 minute),
  exact DEV source, a separately pinned DEV API trust anchor, exact function
  preimages, zero graph damage, proven HTTP binding, and independently proven
  DEV-only Mongo custody. It also rejects any postimage retaining a known
  production/shared endpoint. On success it writes a distinct DEV candidate
  and manifest exclusively into a new external workspace; existing artifacts
  are never overwritten.
- `verify_lk1_subscription_dev_install.mjs` validates a manifest against the
  frozen bound source/candidate and target. With the current blocked binding it
  always stops. It performs no import.
- The production builder reads an explicitly `environment=PROD` binding and
  rejects a DEV manifest. Its candidate binding remains
  `UNBOUND_AFTER_ROUTER_AMENDMENT`; no DEV digest is copied into it.

No Node-RED import, service restart, runtime-global mutation, Viva write, Mongo
write, deployment, or activation was performed.

## Dedicated target provisioning contract (source-only)

A second read-only capture at `2026-09-02T17:12:36Z` returned the same shared
flow SHA and again found no LK Games target. Host topology inspection also found
only the shared root-owned Node-RED process at `0.0.0.0:1880`, shared user-dir
`/root/.node-red`, the existing subscription-shadow service at
`127.0.0.1:3036`, its Mongo listener at `127.0.0.1:27029`, and an nginx
`/api/` route that proxies to production. None is an acceptable base for this
DEV target.

`lk1_subscription_dev_provisioning_contract.json` therefore remains
`BLOCKED_TARGET_NOT_PROVISIONED` and defines a future physically distinct
target:

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

### Future execution plan (requires separate authorization)

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

The current task performs none of these execution steps; it only records and
validates the blocked identity contract. The executable publisher and install
verifier both reject this tracked contract; enabling either stage requires an
explicit future stage-schema change, frozen authorization evidence, and new
independent review.

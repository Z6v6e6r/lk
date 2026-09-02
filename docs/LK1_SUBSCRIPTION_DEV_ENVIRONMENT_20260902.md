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
  writes the snapshot under an external `/private/tmp` or `/tmp` workspace.
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

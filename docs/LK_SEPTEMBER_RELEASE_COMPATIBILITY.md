# LK September release compatibility

Owner: LK Games/release maintainer. Scope: merged group event payment (#64) and
repeat participant removal (#65), before installing companion CUP #17.

The first release preflight found three actual mismatches: production mongodb4
references `clientNode`, the operation router has four outputs, and its game writers
use optimistic snapshot CAS rather than the organizer-handoff membership lock.
The raw group functions also contain installed availability/rejoin expansions.

## Explicit production profile

`production-legacy-cas-v1` is a separate source rendering profile. Shared function
sources retain their mandatory membership lock. The production renderer preserves
four-output terminal responses, saves discovered bookings before cancellation, and
uses exact game ID/version/organizer CAS with `membershipMutation: {$exists:false}`.
Missing snapshot fields are compared with `$exists:false`; they are never omitted.
An observed lock blocks provider routing. Snapshot conflicts follow existing
recovery rather than retrying a local write with relaxed criteria.

This is the installed optimistic protocol, not atomicity between Viva and Mongo.
A concurrent change after provider cancellation can leave local reconciliation
pending. The renderer refuses a graph containing membership-lock functions; it
must not be used to downgrade a future handoff deployment. The ordinary profile
still requires five route outputs and its unchanged lock-dependent source.

The group upgrader applies pinned canonical deltas to exactly two installed
function bodies, retaining all generated and rejoin wrappers. Both preimages and
postimages are pinned, and source drift fails before candidate publication.

## One combined offline artifact

Run from clean reviewed source, with a freshly pulled private flow:

```
node scripts/prepare_lk_september_release_candidate.mjs \
  /absolute/private/input/source.flow.json \
  /absolute/new-private-output deployment-id
```

The output contains one candidate and one exact-graph contract: eleven changed
nodes, four added nodes, no other graph changes. No install or restart occurs.
Use the existing reviewed-flow exact-graph operator after rechecking the fresh
source hash. Never apply standalone candidates sequentially during one soak lease.

Order: compatible LK graph, affected frontend build, then attested CUP service.
Check runtime/API and public bundle hashes. Preserve the exact source backup and
current CUP artifact. The operator's disk/PM2 rollback does not roll back bookings
or Mongo operations; after CUP starts creating DISCOVERY operations, inspect their
recovery state before rollback and prefer forward recovery. Do not replay refunds
or repair previously failed payments as a deployment test.

## Verification

Tests cover actual mongodb4 config identity, legacy/main profile separation,
terminal response routing, pinned graph drift, wrapper preservation, and group
payment behavior. Optional private-flow rehearsal uses LK_RELEASE_SOURCE_FIXTURE.
A real isolated Mongo fixture uses LEAVE_CAS_MONGO_CONTAINER and requires a
codex-leave-cas-* container with no network or host mounts and label
codex.fixture=leave-cas. It verifies snapshot/organizer/lock mismatches, missing
fields, and replay. These are local tests, not provider or production proof.

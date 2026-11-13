# Ordinary game rejoin and previous leave events

An ordinary local game join creates a new `local:*` membership. Previously it
retained the player's old leave events, so the next Viva roster reconciliation
could immediately remove the newly joined player while `joinResponses` still
said `JOINED`.

Both `GameJoinPage` and the game details in `GamesPage` now clear that player's
previous roster blockers in the existing versioned join PATCH. The PATCH writes
the new membership, roster/waitlist, join response and cleaned metadata together.
The helper handles the three existing aliases: `leaveEvents`, `playerLeaveEvents`
and `leftPlayers`. It never matches by name or by the actor who removed a player.
When both IDs exist, they must agree; phone is only a fallback. Other players'
events, malformed entries, `selfRemovalAuditLog` and `leaveOperations` stay intact.
An event with a different strong ID and the same phone is retained. The existing
reconciler's phone-or-ID matching can still block that distinct ambiguous-identity
case; this patch does not change reconciliation identity rules.

The source snapshot determines which blockers precede the new join. Browser
timestamps are not used to infer ordering. A concurrent write invalidates the
existing `expectedUpdatedAt` precondition; the client keeps the 409 and reads
canonical state without replaying the mutation. A later real leave can add a new
blocker normally. Historical `JOINED` metadata never recreates an absent player.

This change only applies to ordinary local joins, including waitlist joins.
Split payment, subscription and canonical roster commands keep their existing
paths. It requires no Node-RED change or data migration. Existing deployed
clients need the updated frontend; this patch alone does not restore a player
already missing from a live game.

## Regression checks

`scripts/tests/gameJoinRosterSync.test.ts` executes the actual ordinary join
payload construction from both pages and then the shared Viva reconciliation,
using synthetic data and no network. It covers roster and waitlist joins,
promotion after waitlist rejoin, repeated sync, a subsequent real leave, legacy
aliases, identity conflicts, immutability and retained audit history.

Run it with the existing reconciliation, membership and CAS tests:

```sh
node --experimental-strip-types --test scripts/tests/gameJoinRosterSync.test.ts scripts/tests/rosterSync.reconcile.test.ts scripts/tests/localMembershipGeneration.test.ts scripts/tests/gamePatchConflict.apiClient.test.mjs scripts/tests/gamesPatchCasAck.test.mjs scripts/tests/gameLeaveMembership.test.ts
```

The join tests already run in the mandatory `test:leave-generation-regressions`
CI gate. There are no new dependencies or workflow changes.

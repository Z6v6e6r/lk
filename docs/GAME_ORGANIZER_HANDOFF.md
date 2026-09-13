# Game organizer handoff

Owner: PadlHub LK Games. Audience: organizers leaving an existing game.

The cabinet list no longer contains the cancel action. Game details load the current roster and the authenticated user's booking. With other active members, the organizer selects an active participant, confirms the role transfer, and then cancels only their own participation using the existing refund dialog and durable self-leave endpoint. No selection means no transfer; failed/unconfirmed transfer never triggers game cancellation. A confirmed transfer remains in effect if the old organizer closes the dialog or their subsequent leave fails.

## Contract and affected code

- `src/components/cabinet/Cabinet.tsx`: removed list cancellation UI and its old handler.
- `src/components/games/GamesPage.tsx`: detail action and unpaid-cancellation guard/error stop.
- `src/components/games/GameBookingCancellation.tsx`: latest-booking lookup, successor selection, verified transfer, self-leave, solo cleanup.
- `src/components/games/gameLeaveMembership.ts`: active membership, eligible successors and booking references.
- `src/utils/apiClient.ts`: authenticated `POST /lk/games/:gameId/organizer/transfer` with `{successorId, expectedUpdatedAt}`. Actor is derived from verified Viva profile, never from the body.
- `scripts/nodered_organizer_handoff_nodes/`: transfer CAS, shared leave/cleanup fences, authority protection and persistence acknowledgements.
- `scripts/nodered_organizer_handoff_nodes/cleanup_prepare_guard.js`: candidate-only explicit organizer cancellation requires no other active membership. Scheduler policy is unchanged.
- `scripts/nodered_games_nodes/fn_split_leave_game_update.js`: local leave CAS requires its own fence.
- `scripts/nodered_games_nodes/fn_split_leave_operation_route.js`: durable terminal receipts release their fence before final response.
- `scripts/build_organizer_handoff_candidate.mjs`: focused patch of the pinned live graph; raw flows/imports remain outside Git.
- Tests: `gameOrganizerCancellation`, `organizerHandoff.nodered`, `organizerHandoff.mongo`, updated cancellation and split-leave regression checks.

Transfer updates `organizer`, metadata organizer authority aliases, and the result-roster organizer in one Mongo CAS. It preserves the former organizer as a participant and does not move booking/payment IDs to the successor. An actual one-row acknowledgement plus UI readback is required. Archived/cancelled games, self/absent/inactive targets, conflicting identity and stale snapshots fail closed.

The top-level `membershipMutation` field serializes transfer against leave and explicit game cancellation. It never expires just because an executor lease elapsed. Leave reuses the existing durable operation key; a changed snapshot is rejected rather than replacing the authorized membership generation. Completion clears only its own fence. Cleanup saves the original task, refund parameters and executor token, rejects concurrent retries, and permits a retry only after a terminal failed attempt has acknowledged its paused state. Confirmed cleanup persistence clears its own fence atomically. A runtime crash during uncertain cleanup requires reconciliation before clearing the fence; do not delete it based only on age.

Generic PATCH now binds its actual Mongo write to the checked organizer/version and absence of a fence, preserving authority aliases. PATCH success and cleanup success wait for Mongo acknowledgement. Canonical roster projection also checks fence absence.

## Evidence

Pinned live source: `e672b79ae011f647d5156d840315543b88e471880236374c2aea2eaf0239f223`, 4799 nodes. Re-read from 147 after implementation with the same hash.

- 19 new server-function cases: authentication, identities, stale snapshot, target eligibility, exact ack, fence ownership, cleanup parameters and stale provider target task.
- Real isolated Mongo on loopback: transfer versus leave on the same preimage permits only one writer; stale PATCH cannot restore organizer; another operation cannot release a fence.
- Existing leave/auth/cancellation regressions and new UI policy tests run locally.
- Local browser fixture: desktop and 390 px; selection required; transfer followed by self-leave succeeds. Network requests blocked by CSP and provider methods disabled in the fixture. This is UI evidence, not live/provider acceptance.
- TypeScript, scoped lint, full repository lint (warnings only), production/dev games bundling and cabinet bundling checked. The full release build remains blocked by missing ignored environment files in this worktree; focused bundling is not a release artifact.
- Updated the existing self-leave source assertion to follow the actual `leaveCurrentUserRequest` adapter and verify its default server API. The old assertion failed on baseline; runtime behavior was preserved.
- Standard modular validation checks the fresh original LK Games graph: no broken wires/links. The handoff builder separately checks its candidate's IDs, wire destinations and function syntax; Mongo/function tests cover the new behavior.

Reproduce candidate (fresh verified workspace required):

```sh
node scripts/build_organizer_handoff_candidate.mjs /absolute/fresh-workspace /absolute/new-candidate-directory
node --test scripts/tests/organizerHandoff.nodered.test.mjs
HANDOFF_SOURCE=/absolute/fresh-workspace/input/source.flow.json node --test scripts/tests/organizerHandoff.mongo.test.mjs
```

Mongo test uses only disposable database `organizer_handoff_verify` on `127.0.0.1:27193`. Start a dedicated fixture before this command; it does not start Docker itself. No shared or production database is a valid target.

## Release and recovery boundary

No import, restart, deploy, real booking cancellation, transfer or provider mutation was performed. A Draft PR is development evidence only.

Before separately authorized rollout: refresh the exact source and review any drift; verify new route ingress and auth/CORS; drain or reconcile existing operations which may already have sent provider requests under the old runtime; verify no unexplained membership fences; deploy the reviewed backend before frontend; perform the approved test-game/provider acceptance and capture role, roster, booking/refund and retry evidence. No automatic migration or backfill is included.

Stop signal: stale role/version, lost persistence acknowledgement, active fence or failed provider verification. Stop method: return conflict/retry with no new authority change; preserve confirmed transfer and durable operation for retry. Do not roll back the guard nodes or remove a fence while its operation may still perform provider writes. A clean frontend rollback alone does not undo transferred roles or completed cancellations.

CI compatibility: the cleanup guard is applied only by the organizer candidate builder. The subscription candidate cleanup source and its immutable hash remain unchanged.

# Game PATCH after a privacy-projected GET

## Failure and scope

The public `GET /lk/games/:id` deliberately removes phone fields, including the
organizer's phone. The cabinet previously echoed that organizer object into an
ordinary roster/metadata `PATCH /lk/games/:id`. The organizer authority check
compared the empty submitted phone with its private canonical value and returned
`409 ORGANIZER_COMMAND_REQUIRED`. Fixing organizer metadata aliases alone did not
remove this independent trigger.

An ordinary edit now omits the organizer object. Organizer handoff remains a
separate command: identity/phone changes, conflicting authority aliases and an
active membership mutation are still refused. The authority check also rejects
an explicitly stale `expectedUpdatedAt` before preparing a write. Callers that
omit this field retain the existing server read/write CAS fence.

A public projection must not erase private storage. The server restores hidden
fields from the same canonical preimage using stable actor/booking identities,
including reordered roster/payment arrays, private URLs and snapshot context.
Ambiguous bindings fail with `GAME_PATCH_PRIVATE_BINDING_UNKNOWN` before any
write. It does not match members by array position or name. Explicit roster
removals and invitation clears remain effective; omitted roster sides and active
payment contacts remain in the private indexes. The PATCH response applies the
existing GET privacy projection; internal followup messages retain private data.

After a confirmed split booking, both cabinet and invitation continuations read
a fresh game without cache before writing. They validate the game/exercise
binding and derive roster, capacity, references and metadata from that version.
The cabinet rereads before its zero-cost confirmation stage. A failed read or
conflicting write stops with a pending-link error. It never replays booking or
payment creation. There is no automatic recovery of historical bookings.

## Source and candidate

Affected functions on the existing regular PATCH path:

- `organizer_handoff_20260913_patch_check` — authority, optional client version,
  private canonical preimage.
- `e0d7883bc1a9fa8c` — restore private projection before the existing guarded
  update; preserve indexes and result snapshot.
- `organizer_handoff_20260913_patch_ack` — redact the successful public reply;
  preserve ACK/CAS and internal followup behavior.

Source files are `scripts/nodered_organizer_handoff_nodes/fn_patch_authority_check.js`,
`scripts/nodered_games_nodes/fn_patch.js` and
`scripts/nodered_organizer_handoff_nodes/fn_patch_write_ack.js`. The shared pure
projection source is `scripts/lib/gamePrivateProjection.mjs`; tests pin its inline
copy. The installed prepare function has an existing wrapper and feature-flagged
bridge guard that differ from the repository base. Do not regenerate the whole
live graph from a stale repository export.

Prepare a candidate only from a fresh private source collected through the
supported audit workflow:

```sh
npm run nodered:modular:audit-147 -- /absolute/new-private-workspace --source-tab-id 4b91e2a2413688db
node scripts/prepare_game_private_projection_candidate.mjs /absolute/new-private-workspace /absolute/new-private-output
```

The offline patcher refuses drift of the three pinned function bodies and
preserves all other nodes, fields, wires and ordering. It produces a full
candidate, three-function import and hash report outside Git. It performs no
network or database calls and does not install anything. The candidate/import
contains private production configuration and must never be committed.

## Verification and release dependency

```sh
node --experimental-strip-types --test scripts/tests/gamePrivateProjection.test.mjs scripts/tests/gamePrivateProjection.frontend.test.mjs
NODERED_RUNTIME_ROOT=/absolute/isolated-runtime node --test scripts/tests/gamePrivateProjection.runtime.test.mjs
```

Fixtures reconstruct the exact installed preimage hashes with synthetic data,
exercise actual GET/authority/prepare/ACK code, test fresh frontend continuations,
organizer takeover, stale versions, partial edits, reordered/ambiguous identities,
private indexes, failed CAS and no provider replay. The optional native fixture
requires Node-RED 4.0.9 and uses a disposable loopback-only runtime with an
in-memory database stub and no provider, notification or inject nodes. CI runs
both fixture layers. It does not prove production MongoDB writes or live UI.

This is a paired backend/frontend release. **Install and verify the backend
candidate before publishing the new frontend**: omitting the organizer against
the old prepare logic can lose private roster fields/indexes. Retain the existing
release/lease/editor prerequisites and take fresh disk/active/editor evidence at
the separately authorized release. Do not deploy a dirty checkout or manually
patch production. A rollback must consider both halves and any intervening data;
it must not blindly restore an old flow over current state.

This change set does not deploy, restart services, mutate production data,
recover existing bookings, charge subscriptions, or send external messages.

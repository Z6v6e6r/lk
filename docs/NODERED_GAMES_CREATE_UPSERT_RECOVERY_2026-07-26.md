# Node-RED games create/upsert recovery — 2026-07-26

## Scope

This cohort records the exact active create/upsert function from a freshly
verified live flow. It does not add routes, import a flow, deploy, restart a
service, or mutate runtime data.

Fixed provenance:

- whole flow SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- active tab `4b91e2a2413688db`, `LK Games`;
- target `e656cff36a8cd210`, `Prepare game upsert`;
- target node SHA256:
  `3f64a79ee3256d811c0e98d9cbb589a8d7cb1ff5eebf4f36a0640b1dfeba4dc0`;
- target function SHA256:
  `08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f`;
- flow totals: 4,614 nodes and 203 HTTP inputs.

The guarded contract covers all 21 nodes reachable from these six POST routes:

- `/lk/games`;
- `/lk/games/records`;
- `/lk/games/payment/confirm`;
- `/lk/games/confirm`;
- `/lk/games/drafts`;
- `/lk/games/draft`.

Every node has an exact full-node preimage hash. Every function in the graph
also has an exact function-body hash. Only the target `func` field may differ
in a candidate; IDs, wires, links, routes, downstream Mongo operations,
responses, diagnostics, and autojoin nodes are invariant.

## Characterized behavior

The live function selects `confirm` for the `/payment/confirm` path and `draft`
for either draft path. A supported explicit `action` (`create`, `draft`, or
`confirm`) overrides that path-derived mode. Draft and confirm require a
non-empty `paymentRef`.

Cabinet booking conversion accepts only an identified `open_game` or
`court_rental`. Tournament, group-training, and unknown categories return 409
through response and debug outputs, with no DB or autojoin output. Singles
format or court naming forces `invite.maxPlayers=2`.

The current live category precedence is also preserved exactly: numeric open
type/direction IDs are evaluated first, then numeric tournament IDs, then
numeric group-training type IDs. If no numeric rule matches, normalized text
markers are evaluated in this order: tournament, group training, open game,
then court rental. This records observed behavior for contradictory metadata;
it is not a new approval of that precedence or of broad text matching.

The persisted record contains a canonical result-roster snapshot built from
organizer, participant, waitlist, booking, invite, and optional seed data.
Active-roster members are identity-deduplicated and capped by the resolved
player limit; waitlist and `allPlayers` remain separate. Each upsert appends one
audit event while retaining only the latest 200 events. The success shape fans
out to DB, HTTP response, debug, and station-autojoin outputs.

## Preserved live defects

Two observed contracts remain intentionally unchanged in this normalization:

1. `/lk/games/confirm` alone remains `create` mode. It becomes `confirm` only
   when the request body explicitly supplies `action=confirm`.
2. The HTTP 200 response is emitted directly from the preparation function,
   in parallel with the Mongo update branch. It therefore does not prove that
   MongoDB completed successfully.

These are documented defects for a later behavior-change cohort. Fixing either
inside source normalization would make the candidate diverge from current live.

## Security residual

The current live function accepts caller-controlled `resultRosterSnapshot`
from either the request body or metadata as seed input to the canonical
snapshot. There is no authorization or trust validation for that seed in this
function. Normalization intentionally preserves this behavior; a separate
behavior/security cohort is required before the snapshot is relied on for
authorization, access control, or other trust-sensitive decisions.

## Guarded result

The fresh verified publication gate passed: source and candidate SHA256 both
remained
`6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`,
the candidate was byte-identical, `changedNodes=0`, and node/route/reachable
totals remained 4,614/203/21. The external publication directory used mode
`0700`; candidate and report used `0600`. The focused behavior, graph, drift,
TOCTOU, redaction, and path-isolation suite passed 11/11 tests.

Candidate flow content stays outside Git; report and stdout contain only
hashes, counts, changed IDs, and changed fields.

```bash
node scripts/patch_live_games_create_upsert.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-create-upsert/candidate.json \
  --report /absolute/external/new-create-upsert/report.json
```

Publication is fail-closed: the verified input is re-hashed immediately before
use, output paths must be canonical and external, an existing/partial target is
rejected, and the new directory/files are atomically published with private
permissions.

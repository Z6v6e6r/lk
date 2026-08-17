# Legacy roster command bridge

The bridge moves an LK `JOIN_GAME` or `JOIN_WAITLIST` decision to the canonical lk2 Games write
owner. It is default-off and does not change the live Node-RED flow by itself.

## Trust boundary

1. The browser posts only `command` and an optional personal `invitationId` to
   `POST /lk/games/:gameId/roster-command`, with its existing Bearer token and an
   `Idempotency-Key`.
2. Node-RED forwards the original Bearer token and adds the server-only
   `PADLHUB_LEGACY_ROSTER_TOKEN`.
3. lk2 asks the ph-ab identity verifier to validate the signed token. The exact signed
   `(issuer, subject)` is mapped to the local user; phone, player, level and roster fields from the
   browser are never accepted as command facts.
4. lk2 resolves the `LK_LEGACY_SNAPSHOT/game` external entity mapping, evaluates participation
   eligibility and commits the canonical roster command.
5. Node-RED writes only the returned trusted projection to Mongo. The write uses a legacy game
   revision/`updatedAt` CAS, retries conflicts, records the canonical command id and treats a replay
   as a no-op.

## Feature flags and secrets

All values are required only for an explicitly approved rollout:

- frontend: `VITE_LEGACY_ROSTER_BRIDGE_ENABLED=true`;
- Node-RED command route: `PADLHUB_LEGACY_ROSTER_BRIDGE_ENABLED=true`;
- Node-RED generic PATCH closure: `PADLHUB_LEGACY_ROSTER_PATCH_GUARD_ENABLED=true`;
- Node-RED target: `PADLHUB_PLATFORM_INTERNAL_API_BASE_URL` and
  `PADLHUB_PLATFORM_TENANT_KEY`;
- Node-RED to lk2 secret: `PADLHUB_LEGACY_ROSTER_TOKEN`;
- lk2: `LEGACY_GAME_COMMAND_BRIDGE_ENABLED=true`, `LEGACY_GAME_COMMAND_BRIDGE_TOKEN`,
  `LEGACY_GAME_IDENTITY_VERIFY_URL`, and `LEGACY_GAME_IDENTITY_VERIFY_TOKEN`.

The two server secrets are distinct. Neither secret is included in a frontend bundle.

## Candidate build

Build only from the audited fresh live source:

```bash
node scripts/patch_live_games_legacy_roster_bridge.mjs \
  --input /absolute/fresh-live/source.flow.json \
  --output /absolute/candidate.json \
  --report /absolute/report.json
```

The script verifies the complete live source SHA and the generic PATCH function SHA before adding
the route. It produces a candidate and report only; it does not import, deploy or mutate live data.

## Activation blockers

Do not enable `PADLHUB_LEGACY_ROSTER_PATCH_GUARD_ENABLED` until every browser roster writer has a
server-authorized replacement. In particular, organizer roster management and the legacy split
payment confirmation path still use generic PATCH in this checkpoint.

Split/subscription games also require a canonical payment-confirmation command before their join
path can be switched: canonical JOIN deliberately returns `SEAT_RESERVED`, and a successful legacy
Viva payment must be correlated server-side before that reservation becomes `PARTICIPANT`.
Enabling the bridge for ordinary games does not authorize bypassing this payment boundary.

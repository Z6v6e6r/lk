# Result-state authentication through CUP

## Current ownership

Player rating is already stored canonically in CUP MongoDB:

- `player_rating_state` is the only current rating state;
- `rating_events` is the append-only history used to rebuild state;
- `player_ratings` and Viva custom fields are compatibility projections;
- the active v2 game-result worker reads `player_rating_state` and does not call
  Viva to calculate rating.

The remaining Viva dependency was outside the calculation itself. While a
result rating job was `QUEUED`, `RUNNING`, `PREPARED` or `RETRYABLE`, the browser
called `GET /lk/games/:gameId/result/state` every four seconds. The shared
Node-RED auth hop validated every such read through Viva `/profile` before
reading local MongoDB.

## Phase-one chain

```text
visible result details
  -> immediate GET result/state
  -> adaptive 12 s poll (30 s for RETRYABLE)
  -> pause while document.hidden
  -> Node-RED shared auth hop
  -> CUP POST /api/internal/lk/identity/verify
  -> cached Keycloak JWKS + local RS256/claim verification
  -> local MongoDB result state
```

Submit, confirm, dispute, correction and session mutations remain on the Viva
profile verifier in phase one. This keeps the first rollout limited to the
high-volume read path while real token claims and revocation behaviour are
confirmed.

## Load effect

For a continuously visible active job, changing `4 s -> 12 s` reduces status
requests by `66.7%` (from 15 to 5 requests per minute). `RETRYABLE` changes from
6 to 2 requests per minute. Hidden tabs generate no periodic result-state
requests and issue one immediate refresh when visible again.

Observed result-state polling represented approximately `87-90%` of the shared
result-auth traffic in the inspected interval. Therefore:

- frontend/Node-RED auth traffic falls by approximately `58-60%` before taking
  hidden-tab pauses into account;
- after `RESULT_AUTH_CUP_TARGETS=state`, Viva `/profile` receives zero calls from
  result-state polling, removing approximately `87-90%` of that result-auth
  load while mutations stay unchanged;
- Keycloak receives JWKS refreshes at most once per cache window/instance, not
  once per poll.

These are request-count estimates. A production soak must compare nginx,
Node-RED, CUP and Viva counters before and after rollout.

## Configuration and staged rollout

CUP/ph-ab must be deployed and checked first. Its required configuration is
documented in the ph-ab `docs/lk-identity-verifier.md` file.

Node-RED configuration:

```env
CUP_API_BASE_URL=http://127.0.0.1:3000/api
CUP_LK_IDENTITY_TOKEN=<same-dedicated-secret-as-ph-ab>
RESULT_AUTH_CUP_TARGETS=state
```

`RESULT_AUTH_CUP_TARGETS` defaults to `none`, so importing the candidate without
the coordinated CUP configuration preserves the current Viva path. The phase-one
activation order is:

1. verify one current access token's exact `iss`, `aud`, `azp`, tenant, phone and
   explicit client-id claims without logging or retaining the token;
2. deploy CUP verifier and test it through localhost/private routing;
3. import the exact live-derived Node-RED candidate;
4. set `RESULT_AUTH_CUP_TARGETS=state` and restart Node-RED;
5. compare result-state success/latency and Viva `/profile` request counters.

Rollback is configuration-only: set `RESULT_AUTH_CUP_TARGETS=none` and restart
Node-RED. No rating state, event or result document is changed by rollback.

## Missing canonical baselines

Missing `player_rating_state` is a data-completeness failure, not permission to
query Viva inside the rating worker or substitute a default rating. The worker
must continue to fail closed with `RATING_STATE_INCOMPLETE`.

Baseline repair is a separate controlled operation:

1. dry-run the affected exact identities;
2. resolve duplicate `clientId`/phone mappings and quarantine ambiguity;
3. append deterministic `RATING_INITIAL_IMPORTED` or approved bootstrap events;
4. create state only when no canonical state exists;
5. read back event/state consistency;
6. requeue only jobs whose four player states now exist.

No baseline apply or live job requeue is part of this implementation stage.

# Node-RED packet: split participant share is never fabricated

Status: **applied to live Node-RED on `lk-primary-147` (2026-09-12) and verified.**

## Objective

The split prepare nodes fabricated the nominal `10 000 / shareCount` (2 500 RUB for four
players) whenever neither a stored nor a requested amount existed, and the subscription
booking response reported that fabricated value, which clients then persisted into the game
record (the live `pay_1fb78942…` case, where the exact court share was 1 000 RUB). The packet
removes the fabrication and keeps one-time pricing on its existing exact-price fail-closed
guard (`SPLIT_EXACT_PRICE_NOT_VERIFIED`).

## Live preimage (pulled, verified)

| item | value |
| --- | --- |
| source | `root@lk-primary-147:/root/.node-red/flows.json` |
| flow sha256 | `e5d643518373698679ad3a209d94db66877de654154a215681a368ac2e5ec332` |
| nodes / `http in` | 4799 / 219 |
| workspace | `/private/tmp/nodered-live-split-nofab-20260912` (private, outside the repo) |

Live function bodies differ from the tracked `origin/main` sources (the tracked sources carry a
newer managed-subscription generation), so the candidate is a **delta on the live bodies**, not a
whole-body replacement:

| node | id | live body sha256 |
| --- | --- | --- |
| Prepare split game payment | `f3f9a60354d394da` | `6f7d6ec86432f5f3a50d0eb080df8847954841a9fc4637d79cf58fb2742fd689` |
| Prepare split join payment | `e92e68bf3f08a70c` | `1360e9a049c34195b536aec34c1bf7bced0d0c21c02db6b68a6ae85a4ea7095c` |
| Route Viva split payment | `8f7bd5b482fe9763` | `53c4f6ab309b4287eaded6c6d16a9c0e34f47c8eac625c58bdf423acfb083d42` |

## Candidate

Built with `node scripts/patch_live_split_nominal_share.mjs --workspace <preimage> --output … --report …`
(publishes into a new private directory outside the repository, receipts with hashes).

| item | value |
| --- | --- |
| candidate flow sha256 | `f6c6c9e2da8a751a28075e44521662f794556052b96c17bed3fc00f59f5b502d` |
| changed nodes | 3 (create 17 lines, join 9, router 9) |
| invariants | nodes 4799, `http in` 219, wiring unchanged, untouched bodies unchanged |

Candidate body hashes: create `b69eb36c138d5b9ae6ac020202148ca6d86f7495b4046811f7dde1473ea0ef9d`,
join `8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074`,
router `d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b`.

Semantics: the prepare nodes resolve the share as `totalAmount / shareCount` → explicit
`body.shareAmount` → stored share → **unresolved**; the subscription response reports
`shareAmount: null` / `shareAmountMinor: null` instead of a fabricated nominal or a zero.

## Evidence

- New regressions (tracked sources): join/create prepare without a price ⇒ `shareAmount === null`;
  subscription response without a price ⇒ `shareAmount: null`, `toPay: 0`. All pass on the
  **live-derived candidate bodies** as well (installed temporarily, then restored).
- Patcher guards: `scripts/tests/splitNominalSharePatch.test.mjs` — exact-once anchor match,
  fail-closed on missing/duplicated anchors and no-op replacements.
- Control experiment over the required CI matrix (`check_9`, 663 tests) with node bodies swapped:
  - unmodified live bodies: 20 failing tests (pre-existing: managed-subscription/DEV-canary
    generation tests that only exist in `main`);
  - live + this delta: 19 failing tests;
  - set difference: exactly one test — the new `subscription booking response never fabricates a
    participant share`, failing before the delta and passing after it. **No regressions.**

## Modular validation

`nodered:modular:build` + `nodered:modular:validate` (`--source-tab-id 4b91e2a2413688db`) pass for
both workspaces:

| workspace | source sha256 | modular candidate | nodes | http in | broken wires / links |
| --- | --- | --- | --- | --- | --- |
| live preimage | `e5d64351…` | `18813fd9ab20780f1621659b3a9c0d95408d6055554439c5fbf65f571a3a79d8` | 345 | 42 | 0 / 0 |
| candidate | `f6c6c9e2…` | `e08c425f62da27fe43601a4b8855e85c398776cea07dadf35b0744b1df9d7b2b` | 345 | 42 | 0 / 0 |

The candidate keeps the preimage topology exactly: same selected node count, same http-input
count, zero broken wires and zero broken links.

## Apply plan (requires explicit owner approval)

1. Fresh pull of `/root/.node-red/flows.json` into a new private workspace (`nodered:modular:pull-147`)
   and verification; abort if the flow sha256 differs from `e5d64351…` or a target body differs
   from the table above.
2. Rebuild the candidate with the patcher, confirm `f6c6c9e2…`.
3. Back up the live flow, then apply through the reviewed flow-deploy machinery (staged import or
   the guarded deploy wrapper) with the lease/journal intact.
4. Verification: flow readback shows the three candidate bodies; a create/join probe reports the
   exact court share (or `null` for a subscription join without a price) and never 2 500; the
   Node-RED process stays `online`; the affected endpoints answer 2xx.
5. Stop signal: any hash mismatch, non-2xx endpoint, or fabricated/nominal share in a response ⇒
   restore the preimage backup and re-verify.
6. Recovery: restore the backed-up `flows.json` and re-run the readback probes.

## Untouched

- Tracked-source pins (`splitPaymentRecovery`, `splitCreateContractPatch`, router contract list,
  `reviewedFlowDeploy` fixture, `lk1_subscription_dev_candidate_binding.json`,
  `lk1_subscription_dev_source_authorization.json`) describe the `main` generation candidate and
  this packet does not rewrite them; the DEV authorization bindings remain the owner's.
- Frontend bundles, game records, CUP campaign configuration and nginx.

## Applied (2026-09-12)

- wrapper: `NODE_RED_SPLIT_NOMINAL_SHARE_DEPLOY=CONFIRM_147 bash scripts/deploy_nodered_split_nominal_share_147.sh`
- deployed source: branch `codex/nodered-split-fail-closed-20260912` at `22131cb23994fa1348d46d07d0633ac31fa7b5b2`
- preimage `e5d64351…` → candidate `f6c6c9e2…`; installed-flow readback equals the candidate
- installed body hashes: create `b69eb36c138d5b9ae6ac020202148ca6d86f7495b4046811f7dde1473ea0ef9d`,
  join `8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074`,
  router `d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b`
- rollback artifacts (byte-equal to the preimage, verified):
  `/root/.node-red/.padlhub-reviewed-flow-backups/flows-pre-split-nominal-share-20260912T081522+0300.json`
  and `contract-split-nominal-share-20260912T081522+0300.json`
- postcheck: Node-RED online under PM2, `/lk/games` probes answer 200, the repaired records still
  report 1 000 / 4 000 and 3 000 / 12 000, no new error-level flow logs
- recovery: copy the flow backup over `/root/.node-red/flows.json` and `pm2 restart node-red`;
  a helper-based rollback needs the reviewed helper re-uploaded, because the wrapper removes its
  remote stage after a successful apply
- deliberately not run: a live create/join probe, because it would create a real Viva booking and
  transaction; the participant-share behaviour is covered by the exact installed bytes (identical
  to the candidate that passed the local regressions) and by the control experiment above

## Behavioural probe (owner-run, creates one real Viva booking)

`scripts/probe_split_join_share_147.mjs` performs exactly one participant join on a designated
game, asserts the server reports the exact court share instead of the fabricated nominal, and then
cancels the created booking again. The payment link is never opened or paid.

Read-only rehearsal (no mutation, works for any future game):

```
SPLIT_JOIN_PROBE_DRY_RUN=1 \
SPLIT_JOIN_PROBE_GAME_ID=pay_aa8d97de-c99b-47ac-8bfd-0d32674f6b1b \
SPLIT_JOIN_PROBE_EXPECTED_SHARE=3000 \
node scripts/probe_split_join_share_147.mjs
```

Real probe (requires explicit acknowledgement, a session token of a test identity, a test phone
that exists in Viva and a game where a short-lived booking is acceptable):

```
SPLIT_JOIN_PROBE=CONFIRM_VIVA_BOOKING \
SPLIT_JOIN_PROBE_TOKEN=<user bearer> \
SPLIT_JOIN_PROBE_PHONE=<test phone> \
SPLIT_JOIN_PROBE_GAME_ID=<pay_...> \
SPLIT_JOIN_PROBE_EXPECTED_SHARE=<exact court share, optional> \
node scripts/probe_split_join_share_147.mjs
```

The probe deliberately sends `shareAmount = 2500/5000` (the fabricated nominal) and fails when the
response still reports that value, when the response share differs from the expected exact share,
or when the automatic cancellation fails (then it prints the exact manual leave command and the
booking id). Without `SPLIT_JOIN_PROBE_EXPECTED_SHARE` the expected share comes from the public
Viva price lookup, falling back to the canonical stored share (`totalAmount > 0`). Note that the
public Viva price endpoint is rate-limited from some client networks (nginx 403), which is why the
explicit expected share is supported.

# Annual subscription deployment package, 2026-09-10

Status: local preparation only. No deploy, PM2 environment publication/restart,
Mongo/provider business write, ledger activation or sales opening occurred.
Existing task branch and worktree are preserved. Base is
`bcf9f7caba517e75584e38be15eb0b7512072c28`; its CI run `34436116735` succeeded.

## Exact binding and preserved upstream changes

| Artifact | SHA-256 |
| --- | --- |
| Fresh live source, 4798 nodes / 219 HTTP inputs | `5fce9a8d20138e0c28f2bb7d6e950fb1f71b31364af423085e4207e807d8e2d5` |
| Prepared candidate, 4799 nodes / 219 HTTP inputs | `12ed9b7a70d086f0640a7d0332213b7baf5b02dd5756eebe0317ec0fc611f31b` |
| HAB graph receipt | `7ab6d09c0c2f1df57310cf9e03179e7ac5427cd3f0b89cb1acc9ef1673018210` |

Upstream changed only `lk_subscription_booking_router_20260804` and
`lk_subscription_price_preview_20260908_router` since the preceding source.
Both are preserved byte-for-byte in the candidate. The approved candidate patch
still changes eight nodes and adds one; there are no removals. The existing price
initializer is preserved. The atomic initializer receives the current HAB receipt
and the previously reviewed persistent configuration loader.

Only four binding metadata fields changed: source hash, candidate hash, booking
router evidence hash and HAB receipt digest. Builder, runtime functions, operator
and tests are unchanged from the green base.

## Private package

Directory: `/private/tmp/lk-annual-history-package-20260910/deploy-package/`.
It contains source and candidate flow files, source metadata, reviewed flow
contract, OFF configuration, deployment plan, and a publication descriptor with
the complete 17-file operator dependency closure in `operator-publication/`.
The plan records artifact hashes; the descriptor binds every operator file and
the candidate hash. Private directories use mode 0700 and files use mode 0600.
Raw flows and operational artifacts are excluded from Git.

`sales-configuration-off.json` contains exactly:

```json
{"kind":"SUBSCRIPTION_SALES_CONFIGURATION_V1","revision":1,"common":false,"hub":false,"piter":false,"raClosed":false,"friendshipClosed":false}
```

This disables annual sales while retaining RA/Friendship admission flags.
It is a local specimen, not evidence that production has these settings.
The last read-only runtime inspection found the Node-RED process online but no
valid persistent `PADLHUB_SUBSCRIPTION_SALES_CONFIGURATION`. The initializer
applies valid environment values, so the candidate hash alone cannot prove OFF.

## Checks and evidence limits

- Annual history tests against this private live fixture: 27 PASS, 0 SKIP, 0 FAIL.
- Seven candidate compatibility suites: 65 PASS, 2 optional-fixture SKIP, 0 FAIL.
- Strict full-graph candidate generation and preservation checks: PASS.
- Isolated modular build and validation: PASS, 142 selected nodes, 13 HTTP inputs,
  zero broken wires or links. This is a selected module check, not the full
  deployment candidate; its hash is deliberately distinct.
- Full runtime/frontend gates reuse successful base CI `34436116735` because
  those source, dependency and command inputs have not changed. No claim of CI
  execution on the new preparation checkpoint is made.

No Linux Mongo execution, real restart/persistence test, runtime OFF attestation,
production candidate installation or new-day stock reconciliation was performed.
Earlier stock and paid-history snapshots are historical and must be refreshed
before reconciliation/opening. Existing financial records must be preserved.
The final optional SSH hash recheck timed out after the initial successful source
download. The candidate remains bound to that downloaded snapshot; the current
server hash must be reread immediately before deployment.

## Subsequent deployment sequence, requiring its own authorization

1. Integrate/publish the reviewed checkpoint and verify successful exact-head CI.
2. Acquire the existing deployment lock; verify process identity, absence of an
   unresolved lease, and an exact fresh source hash. Preserve private backups.
3. Publish the reviewed OFF configuration through the controlled PM2 environment,
   preserving unrelated settings, and verify durable persistence and readback.
   This package does not execute or claim completion of that configuration step.
4. Publish the exact source-bound candidate through the existing reviewed-flow
   operator. Verify installed hash, startup, OFF attestation and affected read-only
   API behavior; retain the deployment receipt and observation evidence.
5. Prepare fresh ledger/provider reconciliation separately. Sales remain closed
   until the independently authorized activation/opening operation completes.

Stop on source/identity/lease drift, missing or ambiguous OFF configuration,
unavailable required readback, or a failed runtime/API postcheck. Recovery is only
through the existing guarded deployment recovery within its lease; never restore
historical business data over later payments. No automatic environment publisher
or new rollback mechanism was introduced in this preparation.

## Local main integration

Approved package checkpoint `9937d1b96eababaa456e812bd0a1d00d19e53ba2` integrated
onto fresh main `c867ed3cf2fea8fe5f27b0b143f1f0f12d3d9a54`. The only conflict was
WORKLOG; both records were retained. The reserve nginx routing commit and all
runtime/operator sources are preserved unchanged.

Integrated checks: critical matrix 548 PASS / 5 SKIP; annual history, candidate
compatibility and primary/reserve nginx tests 99 PASS / 3 SKIP; zero failures.
Strict candidate regeneration retains the exact candidate hash above. Independent
integration review PASS. Full unchanged frontend/build/lint/typecheck inputs reuse
successful exact-base CI `34437567179`; this is not CI proof for the merge commit.
No new runtime code, push, deployment, PM2 control or live business mutation.
Logs and rebuilt private candidate are under the preparation directory's
`integration/` subdirectory. Production readback and configuration requirements
above still apply.

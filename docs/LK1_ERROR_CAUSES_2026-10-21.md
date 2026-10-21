# LK1 production error remediation, 2026-10-21

Status: source changes and local checks; no merge, deploy, runtime restart, database change, payment or provider write.

## Evidence and boundaries

Production was read through alias `lk-primary-147`, with redaction and aggregation on the server. Logs were consumed using inode/byte-offset checkpoints. No player identities, queries, tokens, message content or raw logs belong in this change.

Observed production source: frontend `6207cdebc661e3965bea2b9ad5779e837a10f459`, release `20261021T073115Z`; flow `7253b6985da81abc54b8a15eeb5826b1ee74067edb1840cf191c117d15367784`. These are reviewed preimages, not an acceptance claim for this patch.

Development starts from main `5f8169c2`, which includes community behavior PR213 in addition to the monitored production revision. Before deployment the release owner must account for that baseline difference. This PR does not authorize deployment of either change.

## Findings and changes

| Observation | Evidence and cause | Change / limit |
| --- | --- | --- |
| Repeated auth-consent401 and userinfo parse warnings | SMS password grant omits `openid`; OAuth already requests it. Source mismatch is confirmed; production cohort/upstream status is unrecorded. Mapper also demonstrably maps malformed200, redirects and429 to invalid-token401. | Request `openid` on new SMS grants. Preserve refresh semantics. Parse userinfo explicitly; only upstream401/403 are credential refusals. Transport, non-auth dependency failures and invalid successful claims become retryable503, always before Mongo. Emit fixed diagnostic enums/status/content-type class only. Old tokens are not silently upgraded or discarded. |
| Preview event-target503 | An unchanged compound guard checks upstream, record identity/category/start/duration/location/type/lifecycle. No individual failed predicate was logged. | Preserve every predicate, its order and503 verdict. Emit bounded reason enum and upstream status. Exact production cause remains open until new diagnostics are deployed and observed. Do not relax event validation or invent a price. |
| Preview property-override warnings | Router sets GET; configured HTTP node also hard-codes GET. Node-RED warns on the presence of `msg.method`. | Configure the node as `use` in both the narrow candidate and fresh graph builder; router remains GET-only. |
| Repeating legacy-logo404 | Loopback readbacks of two previously failing public paths returned `Legacy logo not found`. One target was also present in current public summary and still advertised the failing alias. | A self legacy alias is published only when its backing inline data parses. Preserve working modern images, valid legacy data and foreign URLs. Malformed data cannot republish the rejected alias through fallback. This does not recover lost image bytes or establish historical database state. |
| Player-search404 | All three frontend fallback routes have no active handler. User selected search only within an accessible community/tournament, not a CRM-wide directory. | Remove dead network search and its background rating fallback. Current implementation searches already loaded current-tournament participants/waitlist only; no CRM proxy or new directory exposure. It does not yet search community rosters. Show the actual scope and empty state. |
| Risk of linking another player during manual sync | Old fallback selected the first fuzzy result when phone did not match. Other synthetic IDs could bypass the old three-prefix check. | Require a stable UUID client ID or exactly one unique stable identity matching a full normalized phone in the current roster. Missing/ambiguous identity is an explicit error; no name/first-result fallback. |
| MAX send errors | Continuation lines contain provider reason `chat not found`; sender fingerprint alone did not expose it. | Classify as recipient resolution/access failure. Correct chat identity/access is not known. No target is deleted or changed, and no delivery is marked successful. Destination correction needs verified recipient evidence. |

Other open roots: PATCH409 actual binding/version guard; subscription confirm404 actual lookup predicate; missing HTTP-response provenance; `busy-key` overlap/stale-marker distinction; admission audit400; underlying499 close causes. A status alone is not proof of an expected business refusal.

## Scoped Node-RED preparation

`composeErrorCauseCandidate` in `scripts/prepare_lk_error_causes_candidate.mjs` is a pure offline composer. It requires the separately reviewed whole-source digest, exact function pins and expected HTTP configuration, and produces the repository's exact-graph contract. It never imports, deploys or writes a source flow. Test-only alternate pins are explicit arguments, not discovered from the input.

Only seven nodes change:

- `auth_consent_prepare_20260714`: `func` (bounded request timeout, no redirects, clean HTTP state).
- `auth_consent_userinfo_20260714`: `ret`, object to text.
- `auth_consent_build_upsert_20260714`: `func`, strict verifier and redacted diagnostics.
- `lk_subscription_price_preview_20260908_router`: only the existing event-target guard block within `func`; embedded canonical helpers are retained.
- `lk_subscription_price_preview_20260908_final`: `func`, diagnostic allowlist.
- `lk_subscription_price_preview_20260908_http`: `method`, GET to use.
- `9ec08e9a627fa3e2`: only `resolveCommunityLogoFields` within the existing list-response `func`; other helpers and the response tail are retained.

Touched endpoint contracts: POST `/lk/analytics/auth-consents`, POST `/lk/subscriptions/game-price-preview`, GET `/lk/communities`. No routes, wires, config nodes, collections, booking/payment policy, public access rules or subscription charging behavior change. No generated import/full live-flow file is committed. Future release preparation requires a fresh authorized external live workspace and full candidate validation; old broad patch chains remain quarantined.

The historic server-clock upgrader now transforms only the pinned historic final body; later changes to current `final.js` cannot silently enter that earlier upgrade.

A read-only server-memory rehearsal verified current preimages, exactly seven changed nodes, unchanged HTTP inputs/wires and compilation of changed functions. This is preimage/syntax evidence, not an installed-runtime or end-to-end acceptance check.

## Verification

New regressions cover userinfo failure matrix/privacy, new SMS scope with unchanged refresh scope, all event-target predicates, scoped roster identity/ambiguity, missing/malformed legacy backing data and candidate drift/non-target invariants. Existing auth, community summary, media, preview and required LK1 workflow checks are retained. New tests are included in the existing critical CI matrix.

Local prod/dev builds use inert `ci.invalid` configuration and are not deployable production artifacts. TypeScript and lint are checked; lint retains existing repository warnings. Clean installation with local npm11 was blocked by pre-existing missing cross-platform optional entries in the unchanged lockfile; local builds use the existing dependency tree with the same lockfile hash. CI must independently check its locked Node22 installation.

Full workflow tests require a clean committed tree for the legacy release-package fixtures. Tests requiring private canonical flow fixtures remain skipped when those fixtures are unavailable. No real login, recipient send, booking, joining, payment or subscription confirmation is replayed.

## Acceptance after separate release authorization

Confirm the complete release baseline, fresh flow preimages and exact-graph contract. Preserve exact old seven-node preimages and frontend release for rollback. Apply only the separately approved candidate, then read back installed hashes and monitor nonoverlapping windows. A new SMS login must receive the requested scope; valid consent must persist idempotently, not merely return200. A preview200 must have correct quote payload/server time and a real approved user path before claiming recovery. Inspect new refusal enums before selecting a further data/provider/application fix. Rollback or recipient/data changes require their own authorized transition.

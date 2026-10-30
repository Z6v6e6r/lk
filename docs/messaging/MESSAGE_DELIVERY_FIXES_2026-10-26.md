# MAX and LK message delivery — source corrections, 26 October 2026

Owner: task branch `codex/message-delivery-fixes-20261026` in LK, paired with the same branch in ph-admin. Audience: LK players and CUP staff. This change is preparation only: no merge, deploy, provider request, message replay, live database write or permission change.

## Evidence and root causes

Read-only server-147 checks found both outbox dispatch functions at preimage SHA256 `4dd5179f64eeb568e929248623ccbe742a1eb090e1762462cde8c02a97b687b0`, still wired to `maxbot-send`. The dispatch code falls back from external chat ID to external user ID but puts either into `chatId`. These are distinct MAX recipient types. This demonstrates a routing bug when only a user ID exists; it does not establish that every observed 404 used that fallback.

The installed SDK uses `https://platform-api.max.ru`. Current source has a separate fenced sender using the documented v2 endpoint, explicit chat_id/user_id and durable receipt protocol. That source sender is not in the inspected production graph. `SUPPORT_MAX_OUTBOX_MODE` was unset in the running backend process. No endpoint or credential was changed. Changing an endpoint cannot remove a provider suspension or restore a deleted dialog.

On 26 October before 20:45 Moscow time, logs contained 1,270 suspended-dialog403 failures and 207 Chat-not-found404 failures; backend marked 18 commands across three dialogs FAILED after100 legacy attempts. These are different accounting units and may include commands created earlier. Legacy send failures do not reach the success-only ACK path, so expired leases repeat until the attempt cap. The existing receipt-v1 path terminates permanent refusal and quarantines unknown outcomes; it must be activated as a coordinated change rather than patched around with unfenced legacy ACKs.

Player game-chat auth functions exactly matched current source hashes. Every list/read/send auth lookup depends on VivaCRM profile verification. The observed 503 windows coincide with JSON parse/network/EHOSTUNREACH failures there. This change does not bypass verification, cache revoked credentials, or claim to repair external availability.

The earlier audit grouped `/api/messenger/...` with player chats. These are CUP staff endpoints, distinct from player support `/lk/support/dialogs/events` and game/community message APIs. The two staff POST401s have no proven auth defect and guards remain unchanged. A staff POST404 near a restart has a reproducible cold-cache source risk corrected in the paired backend; the exact live request has not been correlated to persisted target state.

## Corrections

- Game message POST: disable generic request retries, including replay after auth/route refusal.
- Community message POST: disable both request retries and cross-origin mutation fallback only for sending a chat message. Other community mutations keep their existing behavior.
- Support message POST: one request to the configured first endpoint, no cross-host or `/lk`→`/api` replay after network/404/405/5xx. GET/HEAD/OPTIONS fallback remains. Deployments needing another write endpoint must configure the correct canonical support base before publication.
- Preserve status/raw error and existing drafts. Network/5xx or malformed-success responses say delivery could not be confirmed and ask the player to check the chat before trying again. No automatic recovery POST is introduced.
- MAX adapter: retain the fixed safe provider code `dialog.suspended`; the paired backend preserves that reason as PROVIDER_REFUSED. Provider descriptions, recipient IDs, message text and tokens are not copied into receipts.

## Contracts and recovery

No new API route, payload, schema/index, dependency or auth authority. Removing retries intentionally favors no duplicate write over silent retry/fallback. A successful HTTP response is not a read receipt or proof of external delivery. The client still lacks a durable end-to-end message idempotency key; a manual retry after checking history can remain ambiguous.

Existing `prepare_max_outbox_receipts.mjs` accepts the inspected dispatch/pull preimages and builds a focused candidate only from a future fresh private flow. No live full-flow copy or import was generated here. Do not run the broad legacy MAX constructor. No Node-RED graph/function body was changed by this diff; scoped constructor/adapter tests cover compatibility, and modular live validation is not an applicable claim.

Before any later authorized activation, follow `node-red/max-outbox-adapter/README.md` and paired `docs/support/MAX_OUTBOX_RECEIPTS.md`: validate complete graph/runtime/module/bot mapping, canonical backend mode and receipt protocol, pause/drain old pollers, reconcile ambiguous leases, prove durable enqueue/order/partial-batch behavior and rate/TLS acceptance. Do not replay existing FAILED/unknown commands or restore legacy pollers as rollback. Text-only adapter scope still rejects attachments; no attachment delivery is promised.

## Verification

- `node --experimental-strip-types --test scripts/tests/messageDelivery.test.ts`: production-function transport fixtures, one POST per failure, lost response after synthetic acceptance, unchanged read fallback and successful echo parsing.
- `node --experimental-strip-types --test scripts/tests/maxOutboxReceipts.test.mjs scripts/tests/maxOutboxRateLimit.test.mjs scripts/tests/maxSupportBridge.nodered.test.ts`: refusal privacy, fenced receipts, duplicate/late sends, scheduling and graph compatibility.
- Existing game-chat identity/membership and support/community auth checks: no auth bypass.
- Configured critical workflow matrix, typecheck, lint and complete prod+dev build with inert `ci.invalid` configuration.
- New regression is included in the exact-head CI workflow. Builds are local artifacts, not a published release.

Baseline before edits:37 focused tests passed. Host npm initially rejected the existing lockfile; Node22/npm10 matching CI installed it unchanged. Docker daemon was unavailable locally; physical Mongo/Node-RED editor acceptance is distinguished from unit fixtures and is covered only when the corresponding CI/installed acceptance actually runs. All provider transports used in tests are synthetic.

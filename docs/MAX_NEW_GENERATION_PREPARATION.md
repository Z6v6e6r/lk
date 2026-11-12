# MAX new-only receiver preparation

This change prepares source functions and mocked acceptance. It does not build an import, mutate a queue, deploy, restart, query provider updates, acknowledge a callback or enable any paused node.

The paired backend change is `ph-admin`'s `docs/MAX_NEW_GENERATION_ISOLATION.md`. Both sides use the public epoch settings `SUPPORT_MAX_GENERATION` and `SUPPORT_MAX_GENERATION_AFTER`; authentication continues through the existing configured `SUPPORT_INTEGRATION_TOKEN`. Every bot flow also needs an exact `MAX_CONNECTOR` of `MAX_BOT` or `MAX_ACADEMY_BOT`. This is not a mode switch to receipt-v1 and does not replace the legacy sender with the incompatible receipt-v1 adapter.

## Mandatory graph, before side effects

For each actual polling receiver, webhook and link-in source:

1. `fn_max_webhook_prepare.js` validates the original provider timestamp in milliseconds and a stable message/callback ID. Old/missing/invalid/seconds/string/future timestamps and unknown IDs stop. A fresh callback uses its callback ID/update time, not the old message's time. An active new-only webhook requires its existing MAX provider secret. The historical Date.now fallback cannot grant freshness.
2. Insert `fn_max_generation_admit_prepare.js` -> HTTP request -> `fn_max_generation_admit_response.js` **before all** lookup, support-route, callback `/answers` and direct-service branches. Native HTTP redirects/retry/catch paths may not bypass the response gate. Configure exact per-bot connector/epoch; missing credentials/config fail closed.
3. The backend atomically reserves a hashed event key with durable acknowledgment. Duplicate/unknown/failed reservation stops. Only a valid matching epoch/admission response permits the business graph; response preparation removes integration credentials.
4. Existing client lookup/support route refuse new-only events without this ticket. The support event forwards the original verified timestamp and ticket; the backend consumes it once before its effects. Do not feed the pre-admission response directly to a sender.
5. Verify domination of **every** live direct sender/callback using the freshly pulled source on147. The eight current disabled nodes remain disabled until that proof and a separate reviewed unpause. A screenshot or these unit tests are not graph proof.

The SDK polling marker is RAM-only and starts undefined after restart. Do not execute GET /updates as an innocuous watermark probe. This feature discards old/ambiguous updates from automatic business processing; it does not establish delivery or a lossless provider cursor. Handler/admission failures remain held for explicit reconciliation, with no automatic replay. Direct service replies must never run on an unreserved event.

## Old queue isolation and release order

The backend's new generation claim fence excludes old Map rows and Mongo residuals in every namespace; row status reset and `fail(false)` cannot provide that guarantee. All queued commands present before the new cutover are old, including commands accumulated during the existing pause. The earlier13:14 pause verification timestamp is not the new epoch.

The installed83 backend needs the existing reviewed cooperative Map/durable/web custody procedure before its first restart. Do not throw away the Map or run a broad hydration as recovery. A clean pushed release, compatible recovery artifact, exact loaded hashes, source/target mapping, closed durable control, private custody union and fake-only runtime checks must precede activation. Source merge and shared backend maintenance are separate transitions; this preparation does not authorize them.

Readiness stays HOLD until backend custody/release, closed-control readback, both actual graph proofs, matching epoch/connector/auth configuration and absence of an older writer are attested. Retain all MAX pauses and SDK guard files. Rollback never restores old dispatchable statuses, deletes the ledger, or starts an older writer that ignores it.

## Validation

`node --test scripts/tests/maxGenerationIngress.test.mjs` tests old/new/unknown timestamps, fresh callbacks, missing/partial config, per-bot identity, token absence, malformed/duplicate/error responses, direct-branch gating and default compatibility with fake inputs only. The existing MAX bridge, response-guard and no-send-retry suites remain required. Real provider transport and unpause are deliberately absent from preparation.

# Auth-consent denial diagnostics and retry gate — 2026-10-25

Status: source-only patch; no real login/refresh, provider/account change, data write, release or resumed monitoring.

The retained archive has 17,806 exact auth-consents HTTP401. Upstream userinfo403/text maps to local401; the provider's exact reason remains unresolved. New SMS/OAuth already request openid. Bitrix webhook ownership is a different incident and is not a cause of these refusals.

Changes:
- Prepare carries fixed unverified token-hint booleans (scope openid present, expiry claim, expected issuer/client claim matches). They never grant access or change the existing provider/client/tenant validation.
- Failed userinfo logs only a bounded RFC6750 error enum from WWW-Authenticate and the boolean/null hints. Realm/description/scope values, bearer, claims, body, identifiers and raw headers are not logged. Generic/ambiguous errors stay unknown; HTTP classification stays compatible.
- A401/403 pauses the same pending consent/token pair across visibility/online triggers. A SHA256 fingerprint persists with the pending audit, allowing reload suppression without storing the token. Without WebCrypto the retry gate is memory-only; no weak token fingerprint is persisted.
- Token change re-enables submission only for the already bound subject. Network/503 retry and idempotent successful audit removal remain. Denial cancels queued retry timers and does not try a fallback host, delete the consent, refresh tokens, log out users or relax permissions.

Evidence limits: no observed failed token was inspected; hints are explicitly unverified, and a provider enum is only what the responding endpoint declared. This patch does not establish or repair the provider's root cause. Module/storage tampering may defeat the client retry gate but cannot authorize a backend write. With blocked storage or unavailable WebCrypto, cross-reload suppression is not guaranteed.

Acceptance:401/403 repeated triggers use one request for the same token, pending audit survives, reload suppresses with SHA256, another subject cannot consume it, new token retries,503 retries, provider/client/tenant refusals still exit before Mongo. No real consent write was replayed in development.

Release boundary: fresh live preimage verification, narrow auth prepare/build candidate plus frontend, with separate approval for deploy. Main includes unrelated changes not necessarily live; do not deploy all main flow nodes or old broad patch scripts. Provider policy/scope changes and reauthentication decisions require new evidence.

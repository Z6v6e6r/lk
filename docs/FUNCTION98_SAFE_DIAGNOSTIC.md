# Function 98: safe Bitrix request diagnostic

The reviewed `function 98` prepares a daily Bitrix deal-list GET request. Its
warning logs the request URL, including a webhook-shaped credential path and
query values. Replace only that warning with a constant JSON diagnostic:

```json
{"event":"bitrix_deal_list_request_prepared","provider":"bitrix","operation":"deal_list","phase":"request_preparation"}
```

This records request preparation, not a successful provider response. Keep the
warning level so existing runtime monitoring still sees the event. No URL,
headers, message/payload, query values, identifiers or exceptions enter this
diagnostic. The outgoing full-message debug is currently inactive; the patcher
refuses an active debug or changed GET boundary. Request construction, returned
message, scheduling and wiring stay unchanged.

`scripts/lib/function98_safe_diagnostic.mjs` pins the diagnosed source SHA256.
`scripts/patch_live_function98_safe_diagnostic.mjs` verifies a fresh external
live-147 workspace and an explicitly reviewed whole-flow hash. It changes only
the target `func` and validates that exact change with the existing graph
contract. Unknown, already-patched and ambiguous preimages fail closed.
No live source, candidate, webhook value or raw log belongs in Git.

## Local checks

```bash
node --test scripts/tests/function98SafeDiagnostic.test.mjs
```

Synthetic tests reproduce URL logging, check constant output for alternate URLs,
encoded query data and newline injection, and prove the HTTP URL/returned message
are preserved. They also cover drift, duplicate targets, active debug, changed
HTTP settings, output aliases, no-clobber and sanitized CLI failure messages.

## Future preparation (no deployment)

Only after a separately authorized fresh live pull using the existing private
external-workspace procedure:

```bash
node scripts/patch_live_function98_safe_diagnostic.mjs \
  --workspace /absolute/private/external/live-workspace \
  --expected-flow-sha256 <reviewed-current-sha256>
```

Without `--output`, this checks in memory and prints hashes/counts only. An
optional `--output /absolute/private/external/new-candidate.json` writes a new
0600 candidate into an existing canonical 0700 directory outside every Git checkout
and the input workspace. Main and linked checkouts are both rejected. It never
imports, deploys, calls Bitrix or restarts Node-RED.
The output contains the surrounding live configuration and must remain private.

The Draft PR does not change production or remove existing logs. Activation needs
separate authorization and a fresh source check. After activation, the next
natural scheduled tick should produce the constant event and preserve the normal
request outcome. Monitor genuine provider/transport failures separately. Do not
allowlist the entire emitter. Restoring the old warning reintroduces the leak;
correct any compatibility regression while preserving safe logging. Existing log
exposure and any credential rotation require a separate operational decision.

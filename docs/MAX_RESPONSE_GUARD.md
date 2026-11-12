# MAX response format guard — source candidate only

Owner: LK/MAX integration. Audience: maintainer of the existing legacy MAX sender.
Observed defect: HTML returned to SDK `res.json()` produced a native SyntaxError
whose message can contain a provider body fragment. This change creates a guarded
local candidate for `@maxhub/max-bot-api@0.2.2`; it does not install or activate it.
No flow, credential, provider origin, dependency/lockfile or outbox contract changes.
The separate `node-red/max-outbox-adapter` is not replaced or activated by this work.

## Behavior

The SDK client delegates JSON parsing to `max-response-guard.cjs`. A failed parse
or failed body read throws a new `MaxResponseFormatError`. Its message is JSON:

```json
{"event":"max_response_format_failed","code":"MAX_RESPONSE_FORMAT_INVALID","upstreamStatus":502,"responseType":"html","reason":"invalid_json","delivery":"unknown","retryable":false}
```

`upstreamStatus` is an integer 100–599 or null. `responseType` is a MIME-derived
enum: `json`, `html`, `text`, `other`, `missing`. It describes the Content-Type,
not proven body content; a mislabeled HTML body may be `json` or `missing`.
MIME parameters/raw MIME values are never included. `reason` is `invalid_json`
or `body_read_failed`. No original exception, cause, body, URL, request, header,
statusText, recipient, message text or token is attached. Body contents remain
inside the native parser; only new allowlisted diagnostic fields escape it.
The existing client debug call also becomes the fixed `MAX_HTTP_REQUEST` marker.

Valid JSON keeps the exact previous return value even with absent/wrong MIME.
The existing early 401 branch is preserved and skips body parsing; it does not
emit the new format diagnostic. Existing valid JSON provider errors retain their
`MaxError` behavior, including provider descriptions. This is not a claim that
all historical SDK/Node-RED logging is free of private data. In particular,
contrib `this.error(err, msg)` still gives the original msg to configured catch
nodes. New diagnostics must not serialize that message or the whole flow.

Fetch uses `redirect: manual`, so HTTP 307/308 cannot automatically replay a POST
or forward it to a Location target. The returned 3xx status/MIME can be diagnosed;
Location is never copied into the new format error.

The prepared messages module removes `attachment.not.ready` recursive sending,
its timer and its log. Each `MessagesApi.send()` makes at most one transport call.
HTML/malformed/empty/read-failed responses are errors, never success output/ACK.
The provider may already have accepted an operation before its response fails:
`delivery: unknown` is intentional. No automatic resend, retry timer, recovery
queue, idempotency claim or operator replay is introduced. External callers or
pollers are outside this SDK patch; their graph must be checked before activation.

## Construct a local candidate

Use a local copy of the SDK package; copying public npm sources requires no
production access. The exact installed caller diagnosed was
`node-red-contrib-maxbot@0.6.1`. The constructor checks SDK package name/version,
client/messages source SHA256 and helper absence. It rejects modified/already
patched sources, symlink aliases, hardlinked source files, nested/repository
outputs and existing output directories. It makes no network calls.

```sh
node scripts/prepare_max_response_guard.mjs \
  /absolute/external/sdk-package \
  /absolute/external/new-max-response-candidate
```

Three files are written into a new private directory, plus a manifest with
preimage/candidate hashes. Input files remain unchanged. A failed/partial output
without its final manifest is not a complete candidate. The output is not a
complete npm package and is not an install command.

Activation requires separate explicit authority and fresh checks of actual SDK
resolution, complete package/caller graph, foreign changes, output/error wiring
and ambiguous outstanding sends. The constructor does not validate the entire
SDK dependency tree, all installed callers, or the flow. Do not copy into a live
`node_modules`, run a broad flow patcher, restart pollers, change endpoint/TLS or
replay messages as part of preparing this fix. SDK reinstall can erase a patch;
a later reviewed packaging/apply mechanism must preserve the exact version/hash
contract. Recovery must preserve unknown delivery and must never replay a send.

Stop signal: version/source mismatch, missing candidate manifest, or unexpected
success/extra transport call in mock acceptance. Stop method: do not activate the
candidate. Production has not been changed by this preparation.

## Verification

```sh
node --test scripts/tests/maxResponseGuard.test.mjs
```

Tests execute exact public client/messages sources plus the actual contrib sender
with mocked transport/SDK Bot wiring. They cover HTML at 200/3xx/5xx, manual redirect policy, lying/missing
MIME, malformed/empty JSON, body read failure, numeric status validation, privacy,
valid JSON and 401 compatibility, one attempt for `attachment.not.ready`, error
outputs/no success ACK, and constructor source/path custody. They do not execute
real sends, production APIs, DB/provider readback or installed-target acceptance.
The existing MAX CI workflow runs these tests in a separate step.

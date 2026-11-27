# MAX PadlHub webhook intake

The `scripts/max_inbound_webhook` service receives new messages for the main
MAX_BOT support connector through an independent HTTPS webhook. The optional
station flow uses MAX directly for its private keyboard and callback answers.
Support replies continue through the existing outgoing queue.

The public exact route `/integrations/max/padlhub/webhook` proxies only to
`127.0.0.1:18941/webhook`. A new dedicated 256-bit webhook secret is mandatory:
exactly one `X-Max-Bot-Api-Secret` header, constant-time comparison, before body
admission or CUP calls. The secret is distinct from bot API and outgoing queue
credentials. Server-only configuration is `/etc/padlhub/max-padlhub-webhook.json`,
regular owner-only file0600 beneath a protected canonical parent. It contains the
secret, expected bot user ID, existing CUP ingress credential when configured,
and only the existing MAX persistence authority connection/collection settings.
No credentials belong in source, flow JSON, browser, URL, logs or release reports.

## Delivery and recovery contract

Authenticated bounded JSON events enter the private inbox
`/var/lib/padlhub-max-padlhub-inbound` (0700, hash-named0600 records). Admission
fsyncs a record and directory before HTTP200. A canonical raw-event hash makes
repeated MID delivery idempotent; a changed payload under the same MID is refused.
Capacity/disk failures return503; records are never silently pruned or replayed.
There is no automatic retention/deletion of this inbox. Monitor its counts/bytes
and capacity before performing a separately reviewed retention operation.

The CLI acquires a private lifetime flock before loading the inbox, held through
shutdown drain. Its unit uses KillMode=mixed; stop prevents new dispatch intents,
finishes the current bounded operation, then exits. An interrupted queued event
can be dispatched later. Each CUP POST is preceded by a durable DISPATCH_INTENT.
The current CUP endpoint returns201; HTTP success alone is not durable acceptance.
The service saves the returned message ID and confirms message content/identity,
attachments, dialog/client links and identity membership with bounded majority
Mongo reads. No database writes are made by this verifier.

An ambiguous POST, identity conflict or unconfirmed persistence becomes REVIEW.
It remains durable and observable but is **never automatically POSTed again**:
the current CUP does not provide restart-safe durable idempotency for inbound
POSTs. Restarting the sidecar cannot reset intent/receipt records. A stored receipt
can be confirmed after restart without repeating the POST. Recovery requiring a
retry is a separate explicit per-record decision, not a queue reset.

## Content mapping

- Fixed connector MAX_BOT and CLIENT/INBOUND, sender/chat identities from provider
  fields. Incoming URLs/connector/credential/phone/station overrides are ignored.
- Bot-origin echoes and non-dialog events are retained as IGNORED. A receiver
  without station configuration handles the original message_created subscription.
- Text is represented in ordered, individually trimmed parts up to1900 characters
  for the current CUP DTO limit. Exact original event/text remains in metadata and
  the private inbox. A receipt and persistence proof is required for every part.
- HTTPS image URLs become the current IMAGE/top-level-url attachment DTO; the
  service never fetches attachments. Other attachments remain in raw metadata and
  have a visible text placeholder. They are not falsely advertised as rendered
  file/audio/video transports.
- Contacts are content, represented as TEXT with raw metadata. This service does
  not bind/verify a phone or impersonate the existing CONTACT identity workflow.
- A valid bodyless event is durably REVIEW rather than discarded or assigned a
  fabricated provider MID. It needs separate supported mapping before delivery.

CUP's existing quick-reply rules can create their normal auto-reply outbox as a
consequence of a natural incoming message; deliverToClient:false prevents direct
forwarding of the event, not configured CUP auto-replies. No legacy NR/GSheet or
SDK sender is invoked by this service.

## Station selection for the main MAX bot

- An attachment-free `/station` opens the station keyboard in the private dialog
  after the receiver verifies that the same MAX user and chat belong to a
  confirmed CUP client. A caption with `/station` and a photo follows the media
  path.
- `message_callback` is admitted only on the same authenticated webhook. The
  receiver uses the actor in `callback.user` and checks the original message
  sender and private chat. The keyboard uses the existing station catalog.
  Known buttons from the previous keyboard are accepted too. Unrelated buttons
  and callbacks with a deleted original message are recorded as IGNORED.
- A selection sends one `STATION_SELECTED` event to CUP. CUP resolves the
  canonical station via its existing action mapping. The receiver proves that
  the new station is recorded on the service message, dialog and verified client
  before editing the keyboard message to confirm the selection.
- The original message ID deduplicates commands. The MAX callback ID deduplicates
  clicks. Both the station write and the subsequent MAX reply have separate
  durable intents. An uncertain write or reply goes to REVIEW without automatic
  replay. The dispatch pause covers station actions. Historical `/station` events
  keep their original inbox disposition.

### Station activation and rollback

The current Node.js runtime on 147 needs the
[official Russian Trusted Root CA](https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt)
to connect to `platform-api2.max.ru`. Use a root-owned PEM file and set
`NODE_EXTRA_CA_CERTS` in a drop-in for `padlhub-max-inbound.service`. Keep
the operating system trust store and other services outside this change.
An unauthenticated `GET /me` returning HTTP 401 from the receiver's Node.js
runtime proves the TLS handshake succeeded. Record the verified PEM
fingerprint and preserve the service drop-in preimage for rollback.

1. Prepare the existing protected receiver config with `stationBotToken` from
   the authorized main bot credential. Set `mongo.serviceMessages` to the active
   CUP collection for service messages from `SUPPORT_MAX_SERVICE_MESSAGES_COLLECTION`.
   The observed value on 147 was `max_support_service_messages`. Verify `GET /me`
   against the configured `botId` from server 147 before activating. Keep the
   existing webhook secret, CUP media token and ownership/mode of the config
   file. The receiver validates bot identity again before station writes or replies.
2. Release the receiver through the existing fenced stop/drain and start
   sequence. Check the original inbox and health, including
   `stationEnabled: true`. This field confirms configuration. Verify provider
   reachability and identity separately.
3. Update the exact existing main-bot subscription in place to include
   `message_callback` alongside `message_created`, using its original URL and
   secret. Read back the provider subscription before proceeding. Other bots and
   webhook subscriptions retain their settings.
4. Verify in a confirmed client's test dialog that `/station` opens the menu,
   the station button updates the CUP profile and dialog, and the next text and
   photo arrive in that dialog. Observe the bot's confirmation and repeat with a
   second station.
5. To revert, restore the exact prior subscription first. Follow the receiver's
   fenced stop/drain and binary/config/TLS drop-in rollback using the same inbox. Previous
   binaries see unfinished station actions as REVIEW and leave them untouched.
   Reconcile these records under the station-capable version before any decision
   to resume pending work. Preserve REVIEW records and the existing outgoing
   archive.

Provider contracts: [callback event](https://dev.max.ru/docs-api/objects/Update/),
[keyboard](https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard/),
[callback answer](https://dev.max.ru/docs-api/methods/POST/answers/).

## CUP Support STAGING handoff

This opt-in path handles only the main bot's own private-dialog flow. An
authenticated `bot_started` with a canonical `cup2_<lowercase UUID>` payload
checks the bot and direct dialogue through MAX before sending one confirmation
keyboard. A `message_callback` with that same payload must come from the same
human and dialogue and name the retained MAX message ID of that delivered
keyboard. The start event alone cannot confirm a request. Ordinary content,
station selection and existing support delivery keep their existing dispatch.

Ordinary and malformed `bot_started` events are acknowledged after recording a
compact receipt in the private inbox. The receipt retains an event digest
without the payload or user fields and never enters dispatch. Identical
redeliveries reuse their receipt. A valid handoff start acknowledged with the
flag disabled stays ignored if MAX retries it after activation. Start a fresh
draft to test after enabling the flag. Each distinct ignored start uses one
record under the existing inbox capacity and is retained without automatic
pruning.

Keep `cupStagingHandoff` absent or set `enabled: false` in the protected receiver
config by default. The authorized STAGING activation may set `enabled: true`,
`proofUrl: https://stg-support.tsup.space/api/support/v1/public/tenants/padlhub/intake/max-proof`
and a separately issued `proofKey` consisting of at least 32 random bytes in
canonical unpadded base64url. MAX identity checks and the keyboard use the bot
token already held by this receiver. The token stays in the receiver. The
handoff endpoint receives only a short-lived HS256 proof in the JSON body.
No incoming event can select a destination or add headers.

The existing private inbox acknowledges durable admission before dispatch.
Handoff records are distinct from station and support records and have a
15-minute local dispatch window. An ambiguous MAX keyboard send is retained as
REVIEW and is never sent again automatically. CUP confirmation retries (timeout,
HTTP 408/429/5xx or interrupted intent) preserve the fixed draft/user/chat and
use a fresh short-lived proof with bounded backoff. CUP must acknowledge the
same already-bound draft and identity with 204. A different identity or
inactive draft returns 409 and is retained for review. The proof also carries a
128-bit confirmation value derived with a domain-separated HMAC from the
draft, user and dialogue. That value stays stable across proof retries.

After HTTP 204 the receiver durably records the confirmation digest before
sending a separate MAX message to the same verified dialogue. The message
contains a fixed return link with the draft ID and confirmation in the
fragment and a button that copies only the confirmation. The draft secret
stays in the browser where the form was filled. A user who opens the link in
a different browser can paste the confirmation into the original form.
The raw proof, raw confirmation and bot token are never
stored in the receiver inbox or logged. A lost or interrupted MAX return send
is retained as REVIEW and is never sent again automatically. CUP may already
have accepted the contact proof in that case. Rotating the proof key with an
outstanding return places that return under review.

Changing MAX subscription types (adding `bot_started` while preserving
`message_created` and `message_callback`), enabling the flag, and sending a live
confirmation are separate activation steps. Verify a controlled private dialogue,
the single resulting STAGING draft confirmation and no legacy deliveries for
its events. A mismatched bot/dialog identity, repeated upstream refusal or effect
on legacy dispatch stops activation. Disable the flag and restore the prior
subscription before restoring an earlier receiver that rejects `bot_started`.
Handoff records remain in custody. Earlier receiver versions see unfinished
handoffs as REVIEW.

## Release and rollback

Build from a clean, pushed task commit using
`node scripts/max_inbound_webhook/build.mjs /absolute/new/private/bundle`.
The manifest pins all seven runtime/config sources and the existing Mongo7.2
worker dependency lock. No new dependency version is introduced. The release
uses an isolated dependency/runtime copy; shared Node-RED/CUP/worker files stay
unchanged. Before activation verify current source/process/config, archive1041
postimages, outgoing health, exact nginx preimage and rollback backups.

Prepare the new unit/inbox/config and exact nginx candidate, check
`systemd-analyze verify`, `nginx -t`, loopback readiness, lifetime-lock ownership,
public unauthenticated rejection and fixed route/TLS. Only then register the
single main-bot subscription with secret and update_types:[message_created].
Preserve and compare the prior subscription list; an unknown registration result
is reconciled with GET, never blindly repeated. Do not register academy, enable
legacy polling, or call GETupdates to investigate pending messages.

Rollback removes only the subscription created by this release (exact URL and
owned preimage), closes this public route/restores its exact configuration and
stops the new sidecar. Keep its inbox and uncertain records. Do not touch the
outgoing queue or old archive. A changed shared nginx file requires reconciliation,
not overwriting another release.

A pre-existing raw Node-RED webhook path may remain reachable on its legacy
listener without mandatory secret. The new service does not expose/forward to it
or claim to harden it. Closing that legacy path requires checking other old
integrations and its worker/flow binding; do not blindly firewall a shared port.

Production acceptance is a fresh **human-sent** MAX message with the same MID
confirmed in CUP persistence and rendered in the conversations UI; also observe
new outgoing receipts and verify archive/process/flow/worker fingerprints.
Historical messages that never reached CUP are not recovered by a new subscription.

## Dispatch pause during an authorized CUP cutover

`/etc/padlhub/max-padlhub-dispatch.pause.json` stops only forwarding from the durable
inbox to CUP. Webhook authentication, disk/fsync admission and HTTP200 ACK continue.
The protected root-owned0600 file has exactly `schema:MAX_INBOUND_DISPATCH_PAUSE_V1`,
an owner `deploymentId` and a fresh64-hex `epoch`. Missing file preserves normal
dispatch. Unsafe/invalid files fail closed as paused; there is no expiry or automatic
unpause. Remove only the operator's own file after matching inode/hash/epoch checks.

The loopback `/health` includes `dispatchPaused`, `dispatchPauseState`, pause epoch/hash
and `dispatcherBusy`. After publishing the pause, require stable matching pause metadata
and `dispatcherBusy:false`: a POST already started before the pause completes its
receipt/majority confirmation first. The gate is checked again after awaited readiness,
before a new dispatch intent. QUEUED records survive restart and resume once; uncertain
intent/REVIEW records keep the existing no-replay behavior. This pause does not fence
other CUP producers or prove that the outgoing queue has drained.

The old receiver does not understand this pause file. Its separately authorized upgrade
uses a short exact503 fence on the existing webhook route, graceful stop/drain, the same
preserved inbox and the new receiver starting paused. Verify its unit/config,90s media
POST budget and120s stop budget, readiness, lock and inbox identity before restoring
the webhook. MAX documents retries for non200/failed delivery (initial60s, then150s,
375s; up to10 attempts and an8-hour subscription limit). Keep this maintenance bounded;
do not acknowledge an event that has not reached the durable inbox, change the
subscription or enable polling. Provider retries may delay the affected event.

Once the webhook is restored, new incoming events stay durable QUEUED while the separate
exact CUP producer fence/drain and release complete. Keep held/outgoing/archive state
unchanged, and verify the deleted1041 records remain absent. A real MAX incoming message
and outgoing delivery receipt are still required after resuming.

Retry contract: [MAX subscriptions](https://dev.max.ru/docs-api/methods/POST/subscriptions)
and [MAX events](https://dev.max.ru/help/events).

## Tests

`npm ci --ignore-scripts --prefix scripts/max_inbound_webhook`

`MAX_WEBHOOK_TEST_MONGO_URI=mongodb://127.0.0.1:<disposable-port> node --test scripts/max_inbound_webhook/*.test.mjs`

The URI is restricted to credential-free loopback. Tests create/drop only a unique
fixture database. Linux CI also tests the actual flock wrapper/child lifetime and
drain. Tests cover auth before disk/CUP, current nullable/MAX201 contracts,
canonical duplicates/conflicts, interrupted publication, intent/receipt restart,
unknown POST/no retry, capacity, FIFO refusal, contact/echo isolation, text parts,
read-only majority verification and no credential forwarding on redirects.

MAX requires HTTPS443/trusted certificate and recommends mandatory webhook
secret. References: https://dev.max.ru/docs-api/methods/POST/subscriptions/ and
https://dev.max.ru/docs-api/objects/Message .

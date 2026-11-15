# Prospective MAX PadlHub webhook intake

The `scripts/max_inbound_webhook` service restores **new message_created events**
for the main MAX_BOT support connector through an independent HTTPS webhook.
It does not change Node-RED, the unpaid worker, the outgoing sender/queue, or any
legacy custody/archive record. It makes no MAX send or polling calls.

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
- Bot-origin echoes and non-dialog events are retained as IGNORED, not fed back
  into support. Only message_created is registered initially.
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

## Release and rollback

Build from a clean, pushed task commit using
`node scripts/max_inbound_webhook/build.mjs /absolute/new/private/bundle`.
The manifest pins all six runtime/config sources and the existing Mongo7.2
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

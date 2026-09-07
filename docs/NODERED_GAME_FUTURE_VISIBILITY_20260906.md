# Future LK game visibility fix

## Scope

This change fixes only game records created after the reviewed activation time.
It does not rewrite, backfill, archive, or otherwise change existing `lk_games`
documents. Existing invisible games remain outside this delivery.

No Mongo migration principal or writer barrier is required for this scope. The
change introduces a new forward-only writer contract rather than changing old
records while production writers are active.

## Root cause

The live create path could persist a game without the platform tenant and
without a numeric revision. The cabinet list projection is tenant-bound, so a
successfully created record could then be absent from the user's game list.

The future writer now:

- assigns the server-owned tenant `iSkq6G` and rejects a conflicting runtime or
  caller tenant;
- uses one deterministic `_id` per Viva exercise or normalized booking slot;
- increments a numeric revision and waits for majority-journaled Mongo
  acknowledgement plus exact readback before returning success;
- derives `PAID`/`PAYMENT_PENDING` and `archived=false` on the server from the
  verified create mode instead of accepting caller state markers;
- refuses an ordinary retry that encounters an existing durable identity,
  preventing a second write;
- authenticates the caller with the current Viva bearer and verifies the exact
  organizer booking, exercise, studio, room, date, start, end, settlement kind,
  and provider price;
- permits direct create for zero-due, subscription, or already card-paid
  bookings only when the authenticated Viva booking readback confirms the exact
  organizer, slot, `PAID` state, and price (Viva minor units are normalized to
  the LK ruble amount). A subscription requires the exact provider payment type
  `SUBSCRIPTION` and remains classified as such even when Viva also reports a
  positive transaction status.
  Direct card-paid conversion is allowed only when the
  booking payload has no payment reference; any referenced positive card
  payment still uses the provider transaction readback, durable claim, and
  confirmation path. An ambiguous
  Mongo acknowledgement on that path is resolved only by an exact paid-state
  readback, and an exact confirmation retry reads the already committed
  revision.

The cabinet frontend sends the bearer on create, draft, confirm, and update
requests. The frontend bundle must be released before the Node-RED route rewire;
the current backend tolerates that extra header.

## Flow variants

`scripts/patch_live_game_future_visibility.mjs` consumes only the exact frozen
live flow SHA-256
`e38f844343ef290aa49f2583861dfc4488031b97d303ccbe36b3a5e12c292ec3` and emits:

- `foundation`: authenticated future writer with payment confirmation disabled;
- `candidate`: authenticated future writer plus provider-confirmed payment;
- `recovery`: keeps the tenant/revision writer and disables payment
  confirmation, so source bytes are never restored after the first possible
  organic future write.

The function contains a reviewed UTC `notBefore` literal. Exact-graph contracts
pin that literal to the changed create node. Preflight and apply require enough
lead time for the 15-minute lease and the four-minute worst-case source rollback
budget.

If a restart fails near or after activation, the deployment lease remains. The
installer keeps protected source, contract, and candidate backups. The
`reconcile-current` action validates all three, republishes the exact candidate
when necessary, restarts Node-RED, writes a pending intent, and writes a success
receipt only after runtime verification and matching lease release. A durable
intermediate verified receipt lets the same reconciliation stamp finish lease
release or success publication after a process interruption without restarting
Node-RED again.

## Delivery gates

The safe order is:

1. build and release the frontend bearer change;
2. refresh and freeze the live Node-RED source immediately before preparation;
3. regenerate candidate and exact contracts with a future activation time;
4. deploy the reviewed flow while the full activation and rollback budget
   remains;
5. verify PM2, active flow digest, create response, tenant-bound list readback,
   and unchanged payment/provider state.

Every deploy, restart, production write, and live postcheck remains a separate
authorized stage. The current repository checkpoint performs none of them.

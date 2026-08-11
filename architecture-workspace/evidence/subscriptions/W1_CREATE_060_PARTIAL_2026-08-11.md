# W1/W2 Partial Live Evidence — CREATE 60

Observed at: `2026-08-11T07:40:56Z`–`2026-08-11T07:41:46Z` /
`2026-08-11T10:40:56+03:00`–`2026-08-11T10:41:46+03:00`

Case: `GHAR-BKG-CREATE-060`

Evidence status: `PARTIAL_BALANCE_CONFIRMED_NO_HAR`.

This report contains aliases and non-sensitive runtime values only. Exact
client, subscription, booking, exercise, station, court and payment references
are stored in the private run registry outside Git.

## Authority and baseline

- the user explicitly assigned `tester-entitlement-a` as a synthetic tester;
- the authenticated LK profile was matched to that tester through the visible
  profile data;
- the user supplied a Viva action-history screenshot with authoritative
  pre-create visits balance `B0 = 15`;
- the user approved creation at any station on `2026-08-22`;
- the served LK release remained `20260811T034751Z`, source commit
  `ed809293390ca538ec4757c0f303880c5e00286f`.

## Exact test target

| Field | Alias-safe value |
|---|---|
| Tester | `tester-entitlement-a` |
| Subscription | `subscription-sport-a`, active |
| Station | `station-test-yasenevo-a` |
| Game | `game-create-060-a` |
| Service date | `2026-08-22` |
| Time | `07:00–08:00 Europe/Moscow` |
| Provider duration | `60` minutes |
| Court | `court-test-a` |
| Format | doubles, split payment |
| Availability | private |
| Roster after create | one synthetic organizer, three free places |
| Real customer present | `false` |
| Real-money amount | `0` |

## Observed lifecycle

1. The create form returned available station-local slots for 22 August.
2. A 60-minute slot and court were selected.
3. Split payment displayed the active subscription as an available organizer
   payment method.
4. The final form was set to private; no community checkbox remained selected.
5. The submit action was performed once. The UI disabled the button and did not
   immediately show success. No retry was performed.
6. After delayed readback, the LK showed an exact paid game with one organizer,
   three free places and subscription payment mode.
7. The detail view still exposed a station-community publication-removal row.
   That publication was removed successfully.
8. Returning to the cabinet and expanding bookings showed the new 22 August
   game with an available cancellation action and no other participants.
9. A separate read-only games API readback matched the private registry's exact
   game, exercise, booking, station, court and subscription identifiers.

## Contract findings

### Confirmed

- current LK can create a provider-confirmed 60-minute game using an active
  client subscription;
- the resulting game, provider exercise and provider booking can be correlated
  by exact ids;
- create is zero-amount for the organizer when the subscription method is
  selected;
- the result is projected back into the cabinet after returning from create;
- the one-click/no-retry rule prevented a duplicate while the response was
  delayed;
- publication removal completes and disappears from the detail view after
  readback.

### Unexpected or ambiguous

- private selection plus an empty selected-community list did not remove the
  station-community publication row from the created-game detail view;
- the UI did not expose an unambiguous progress/result state for several
  seconds after submit;
- the active subscription detail modal does not display visits balance;
- raw DevTools HAR is unavailable through the current browser transport.

The publication behavior must be treated as a contract gap until a raw HAR and
provider/local publication readback explain whether it was an actual post,
default station routing, or a stale UI projection.

## Remaining gates before cancellation

| Gate | Result |
|---|---|
| Synthetic tester | `GO` |
| Exact private ids | `GO` |
| Safe 60-minute target | `GO` |
| `B0 = 15` | `GO`, user-supplied Viva screenshot |
| Create exact-id readback | `GO` |
| Game removed from station publication | `GO`, LK detail readback |
| Post-create balance `B1` | `GO`, `15 -> 14` confirmed by follow-up Viva screenshot |
| Raw create HAR | `NO_GO`, browser transport unavailable |
| Approved cancellation/refund option | `NO_GO`, not yet captured |
| Post-cancel balance `B2` | `NO_GO`, cancellation intentionally paused |

Follow-up: `game-create-060-a` was already cancelled by an external/concurrent
actor before Codex attempted cancellation. No duplicate cancel was sent. See
`W1_CANCEL_060_EXTERNAL_PARTIAL_2026-08-11.md` for the fail-closed readback and
the contaminated balance timeline.

## Next safe action

1. Preserve the confirmed `15 -> 14` screenshot in private evidence.
2. Do not retry cancellation for the already-cancelled target.
3. Repeat the lifecycle only in an exclusive mutation window with raw HAR.

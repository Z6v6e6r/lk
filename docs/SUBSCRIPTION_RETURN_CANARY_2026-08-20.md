# Subscription return binding — production canary protocol (2026-08-20)

## Scope

This protocol records the guarded production rollout and one synthetic canary
for exact subscription-instance binding during split-game leave. It is release
evidence, not a reusable client fixture. The tester phone, Viva client and
`clientSubscriptionId`, authorization material, cookies and the full game ID
are intentionally omitted.

The rollout changed only the six reviewed Node-RED function bodies that persist
and consume the provider-confirmed subscription-instance binding. It did not
publish a managed subscription policy or enable a new purchase flow.

## Release identity

- deployed repository commit: `3c63432e1de616c946c431ff4647e7777f36d05c`;
- verified live preimage SHA-256:
  `2cbb00db7983248b212fcd2fc227795277a4d90b7dd3ace804655829a68f3828`;
- active flow SHA-256 after apply:
  `5b2c0808b88910e1aafa2639e4c876e53f86cac0e40d8e76fa7d28fd205b4852`;
- deployment timestamp: `20260820T172959+0300`;
- flow backup:
  `/root/.node-red/.padlhub-reviewed-flow-backups/flows-pre-subscription-binding-20260820T172959+0300.json`;
- contract backup:
  `/root/.node-red/.padlhub-reviewed-flow-backups/contract-subscription-binding-20260820T172959+0300.json`.

The repository `main` may advance independently after this deployment. A later
Git SHA is not evidence that a different Node-RED flow is active; production
truth is the active flow digest plus the runtime postchecks below.

## Guarded deployment evidence

- the deploy ran from a clean checkout whose `main` matched `origin/main` at
  the mutation boundary;
- the contract pinned the complete changed-node set and rejected additions,
  removals, rewiring and non-function changes;
- the live flow mode was corrected to `0600` before apply without changing its
  content digest;
- the remote candidate and contract used a private temporary stage, which was
  removed after completion;
- the active digest matched the reviewed candidate after restart;
- PM2 reported Node-RED `online` with zero unstable restarts;
- the public Games postcheck returned HTTP `200`;
- automatic rollback was not triggered.

## Canary scenario

Preconditions:

1. Use the separately approved synthetic tester and a dedicated paid split
   game; do not reuse a real customer's subscription.
2. The tester is present in the game through a subscription-backed booking.
3. The provider-confirmed client subscription instance is bound to the exact
   participant payment row; a catalogue product ID is not accepted as instance
   evidence.
4. The subscription read-back shows `269` visits before leave and the operation
   expects exactly one returned visit.

Action performed once:

```text
POST /lk/games/:gameId/split/leave
reason = PLAYER_LEFT
```

The request was initiated manually in the authenticated browser. It was not
repeated after the browser result became available.

## Required evidence and observed result

| Layer | Required evidence | Observed result |
|---|---|---|
| Browser | Explicit successful return message | `Вернули занятие на абонемент.` |
| Public game read-back | Tester absent, organizer retained | `participantCount=1`, tester absent, organizer present |
| Game state | No game cancellation side effect | Game remained `PAID` |
| Durable operation | Terminal saga state | `DONE` |
| Return verification | Provider return confirmed | `RETURN_VERIFIED` |
| Visit count | Exactly one visit returned | `subscriptionVisitCount=1` |
| Transition order | Full mutation chain completed | `STARTED -> VIVA_CONFIRMED -> LK_APPLIED -> DONE` |
| Subscription balance | Provider read-back matches expected result | `269 -> 270` |

The canary is successful only when all rows agree. A browser toast or HTTP `2xx`
alone is insufficient.

## Soak

The post-canary soak ran for 15 minutes from `18:13:37` to `18:29:16` MSK:

- 30 of 30 samples retained the active flow SHA-256 `5b2c0808…`;
- PM2 remained `online` in every sample;
- the public Games API returned HTTP `200` in every sample;
- the final game read-back still showed only the organizer;
- the final operation read-back remained `DONE / RETURN_VERIFIED` with the
  single `269 -> 270` return.

No retry, second leave, additional write-off, additional return or rollback was
performed during the soak.

## Rollback boundary

Rollback was not required. The exact backup pair above remains the only approved
rollback source for this deployment. If rollback is separately authorized, run
the guarded command from a clean `main` checkout that matches `origin/main`:

```bash
NODE_RED_SUBSCRIPTION_BINDING_ROLLBACK=CONFIRM_147 \
  npm run nodered:subscription-binding:rollback-147 -- \
  20260820T172959+0300
```

After rollback, verify the restored flow digest, Node-RED/PM2 state, public
Games HTTP `200`, and the affected authenticated leave path. Do not manually
copy or edit the live flow.

## Release conclusion

The exact subscription-instance return binding is production-verified for the
single approved synthetic self-leave canary. This proves the tested binding and
return path only. It does not prove purchase, administrative issuance, managed
policy publication, discounts, limits, no-show handling, organizer removal, or
other subscription lifecycle branches.

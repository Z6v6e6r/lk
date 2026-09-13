# Exit from a game with an orphan waitlist payment

Owner: LK frontend. Audience: players leaving a split-payment game, including a
player missing from `participants` and `waitlist` but still represented by an
active `metadata.splitPayment.payments` row.

The prior UI offered self-leave for roster members and unexpired `PAYMENT_PENDING`
only. After exhausted server retries it treated empty roster membership as a
successful exit, without checking a remaining `WAITLIST` payment. The personal
schedule correctly still regarded that row as an active relationship.

The frontend now exposes the existing authenticated self-leave action for every
active payment membership. A deadline alone is not removal evidence. It checks a
fresh exact-game response before showing success, including after `DONE` and
`RETURN_PENDING`. The refreshed record replaces the local record. Membership
matching uses strong IDs before phone fallback; another client's payment cannot
be matched solely by a shared phone. A join running in this page disables leave.

The existing server endpoint `POST /lk/games/:gameId/split/leave` remains the only
write path. Its `fn_split_leave_game_update.js` removes waitlist/roster/phone links
and marks matching payment rows `LEFT`, preserving payment references and audit.
Fresh read-only inspection on 147 confirmed that this function matches the source
used in the regression. No Node-RED source, import/export or provider behavior is
changed by this patch. Refund completion is separate: `RETURN_PENDING` remains
visible as a pending return, not a successful refund.

Validation includes the real frontend callback with in-memory API boundaries,
orphan/expired WAITLIST, pending/paid/terminal states, conflicting identities,
rejoin, unreadable or wrong-game responses, and the real server CAS builder
clearing WAITLIST while retaining another player and a pending refund.

Stop signal: the fresh game still has active membership or cannot be read.
Stop method: keep the player on the details page, clear the busy state and show an
unresolved-exit message; do not manufacture local removal or issue client-side
provider calls.

Limits: this is not a live data repair or deployment. Existing historical
same-generation receipt replay and legacy join-projection overwrite paths are
unchanged; if those retain an active payment, this UI exposes the unresolved exit
instead of claiming success. A new legitimate join remains active. Rendered
authenticated UI and live leave/provider/refund mutations are not part of local
acceptance.

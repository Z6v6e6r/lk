# Unavailable game reads

Owner: LK frontend. Audience: players opening game details, chat, or an invite.

This compatibility source builds only communities.js from its installed baseline.
The terminal overlay UI is published from the separate cabinet/games sources.

A 404 from `GET /lk/games/:gameId` or `GET /lk/games/:gameId/result/state`
ends that read without a retry and is presented as **Игра недоступна**. Network
failures and 5xx retain their existing retry and origin-fallback behavior. The
optional retry policy is used only by these reads; mutation policies are unchanged.

In the game overlay, either 404 enters a separate `unavailable` step. Existing
step-scoped cleanup stops game details, result polling (including visibility
wakeups), chat and roster background work. Unread polling is suspended while this
screen is open. Requests already in flight may finish; cleaned-up effects ignore
late results. The terminal screen offers navigation back to the cabinet rather
than stale game actions. An invite clears its stale game record on a read 404.

The state is local to the mounted view, not a permanent negative cache. Closing
and reopening the overlay or opening another game permits a fresh read. The
server's archive/visibility rules and stored results are not changed.

## Validation

`node --test scripts/tests/gameReadUnavailable.test.mjs`
executes actual API functions with a mocked transport and actual effect callbacks
with controlled timers. This compatibility branch retains its installed artifact source; the main PR CI suite imports these tests.
Cases cover terminal 404, no fallback after a prompt 404, transient retries,
200/304, unchanged mutation retries, poll cleanup, visibility wakeups, late
responses, reopen/switch, and the accessible terminal UI.

Stop signal: a valid available game is incorrectly reported unavailable, or
background reads continue after the terminal screen. Stop method before release:
leave the PR unmerged. After a separately authorized release, use the established
frontend rollback procedure for the published artifact. This change adds no flag
and does not authorize publication or any business operation.

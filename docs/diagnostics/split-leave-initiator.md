# Browser initiator diagnostics for split leave

This is an informational diagnostic for each admitted POST through the shared
`request()` client to `/lk/games/:gameId/split/leave`. It covers self leave and
the legacy participant-booking cancellation caller. It does not change the leave
request, confirmation, authorization, body, retries, response or reconciliation.
No global fetch/confirm override is installed. Calls bypassing `request()` are
outside this instrumentation.

The event uses the existing `client_error` transport, with
`code=SPLIT_LEAVE_INITIATED`, `stage=leave_initiator`, `method=POST`,
`source=browser`. Exclude this code from error-rate alerts: it describes an
attempt, not a failure or a successful server-side leave.

## Recorded fields and privacy boundary

- `callerBuild`: the existing source commit hash, or `UNKNOWN`.
- `logicalOperation`: the existing random diagnostic operation ID, unrelated to
  a client, game, booking, token or browser session.
- `leaveTrace.frames`: at most eight frames, each rebuilt from a fixed asset-name
  enum and integer line/column (0–10,000,000). V8 and WebKit locations are parsed
  synchronously before the API client awaits anything. Unknown scripts are
  omitted. Function names, raw stack, origins, paths, query and fragment are not
  retained. For production use the immutable `games.js`/`bundle.js` (or dev
  counterparts) to resolve the locations. `callerBuild` identifies the emitting
  bundle; in a mixed-version page, resolve other assets against their actual
  loaded release rather than assuming every frame has that source hash.
- `leaveTrace.actions`: at most eight observations from the preceding 120 seconds,
  with fixed action/kind enums, relative monotonic age and, for DOM observations,
  `isTrusted`. Named controls cover game join/leave/back and booking cancellation;
  other buttons/links inside the widget (including subscription-option join
  buttons) become `OTHER_CONTROL`. Pointerdown and
  click are separate observations of a possible single activation. Enter/Space
  activation is recorded as `key_activate`; the actual key is not retained.
- The existing native leave confirmation explicitly records `CONFIRM_ACCEPT` or
  `CONFIRM_DISMISS`. This is a browser observation, not proof of user intention.
- Document visibility is `visible`, `hidden` or `UNKNOWN`.

No DOM nodes, text, input values, URLs, coordinates, request bodies, user/game/
booking IDs, names, phone numbers, cookies, tokens or authorization headers enter
the trace. Ordinary diagnostic event/request IDs and untrusted device event time
remain part of the existing envelope. The `client_error` path excludes the generic
analytics user/session/device/page envelope and Firebase; fetch uses
`credentials: omit`. The existing bounded delivery queue stores only sanitized
events and re-sanitizes them on replay. Only already-sanitized traces can enter
that queue; the recent-action buffer itself is memory-only.

## Reliability and interpretation

Main and games bundles share one recorder, three passive capture listeners and a
limit of six initiator events per rolling minute per document. They are installed
at bootstrap once, survive overlay close/reopen, and disappear with the document.
No typing, mouse movement, scrolling or outside-widget controls are collected.
The action buffer expires lazily on record/capture and never exceeds eight rows.

The emitter is best effort, does not await analytics delivery and catches failures.
A browser crash, navigation, blocker, unavailable crypto/network, rate cap or an
unsupported stack format can lose diagnostics. Absence of an event is not proof
that no request occurred. `logicalOperation` links this event to the API client's
browser error diagnostics. It is not sent in the business POST and cannot by itself
identify an authenticated actor or a durable server operation. Device times and
browser claims are untrusted. Use the build, source coordinates and preceding
observations to investigate a subsequent occurrence; they cannot reconstruct the
original historical session.

## Activation and compatibility

Source preparation is not activation. No deployment is performed by this change.
For an authorized release, update the existing server diagnostics collector/core
first, then publish the frontend using the normal release procedure. The canonical
core is self-contained; no additional server dependency is needed. No Node-RED
business function or flow regeneration is required for this schema extension.

The nested field is admitted only for the exact source/event/method/route/stage/code
combination above. The browser sanitizer, queue, server `clientEnvelope`, offline
collector and generated JSON schema use that contract. An old collector strips
the new trace and normalizes the new enums to `UNKNOWN`; publishing the frontend
first therefore loses detail. Do not treat a 200 from analytics as proof that the
trace was persisted. After an authorized rollout, verify with a synthetic account
that the persisted event retains frames and actions and has no private fields.

Adding the route template also admits this route to the existing optional server
diagnostic middleware. Its effects are response diagnostic correlation headers
and technical ingress/terminal observations; it does not alter the business
payload, status or invoke/replay leave. The regression suite verifies that boundary.
An older offline reader safely drops unknown fields. Rollback to older source
stops emission/reading of the extension without changing membership state.

Validation: `npm run test:correlated-error-diagnostics` includes the focused trace,
privacy, replay, transport, request non-interference and server intake tests. The
same test file is explicitly included in the mandatory CI workflow.

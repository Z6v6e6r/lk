# Local-only community invite diagnostics

Owner: LK backend. Audience: operators investigating invite-join HTTP 422.
Status: local patch only; no settings, Node-RED imports, deployment, restart,
HTTP requests, database reads or provider calls are included.

`scripts/diagnostics/community-invite-422.mjs` constructs an in-memory candidate
changing only `func` on the enabled route's `Apply invite join` node. It accepts
only the reviewed function SHA `f725d598092b5c15b89fa81cbab81c6ea3d564b566538a0c004bc5eb3d4c3819`.
The known active function differs from the generic event-guard generator; do not
regenerate that generator or import a historical flow to apply this diagnostic.

Each of the two existing 422 return sites emits at most one JSON string via
`node.warn`. Logger failure is swallowed; HTTP payload, status, response identity,
write outputs, auth, membership/ownership and policy validation are unchanged.
Other outcomes, including success and auth/policy/CAS rejection, emit no record.

Allowed fields:

| Field | Allowed values |
| --- | --- |
| `code` | `COMMUNITY_INVITE_JOIN_422` |
| `route` | fixed `/lk/communities/join-by-invite` |
| `httpStatus` | `422` |
| `branch` | `registration_challenge`, `registration_validation` |
| `reason` | `EVENT_REGISTRATION_REQUIRED`, `EVENT_REGISTRATION_INVALID`, `UNKNOWN` |
| `registrationPresent` | boolean, challenge branch only; supplied/non-null, not validated |
| `revisionMatches` | boolean, challenge branch only; exact request/current revision comparison |
| `retentionMatches` | boolean, challenge branch only; true if no rolling requirement or its mode matches |

Example, using constants and booleans only:

```json
{"code":"COMMUNITY_INVITE_JOIN_422","route":"/lk/communities/join-by-invite","httpStatus":422,"branch":"registration_challenge","reason":"EVENT_REGISTRATION_REQUIRED","registrationPresent":false,"revisionMatches":false,"retentionMatches":true}
```

No invite values, user/community/request identifiers, hashes of private values,
names, company/contact/form values, headers, URLs/query values, auth, request or
response objects, arbitrary field names or exception text enter the sink.
Unknown exception messages become `UNKNOWN` in diagnostics; the existing HTTP
response is preserved. Invalid field category and eventual membership outcome
remain unknown; the observer does not rerun the private form parser or query data.

The builder refuses missing/ambiguous enabled route, altered function source,
duplicate node identities, missing/disabled/dangling reachable nodes, changed
response-port shape, shared enabled HTTP ingress, linked/cross-tab ancestry and
reapplication. Disconnected passive legacy Mongo nodes are tolerated; no-input
functions and ancestor functions with On Start code are refused along with
autonomous inputs. It does not run or deploy a flow.

Stop signal: any unexpected diagnostic field, incorrect route attribution,
changed business output or source/graph drift. Stop method for this local patch:
discard the candidate. A future activation requires separate reviewed fresh
preimage and execution authority; a business-source change requires a newly
reviewed pin. Existing reviewed recovery applies to any future activation; this
patch adds no installer or live rollback operation. It provides one small record
per refusal, with no sampling, persistent state, global context or identifiers.
Real warning persistence/delivery and live log-volume effects are unverified.

Checks:

```sh
node --test scripts/tests/communityInvite422Diagnostics.test.mjs
```

Set `COMMUNITY_INVITE_422_FIXTURE` to an existing private external flow snapshot
to exercise the additional exact-preimage/topology/alternate-ingress rehearsal.
The test never writes that snapshot or exports its nodes. The previous offline
business-contract suite can also run with the patched source and mocked lookup/
commit to verify auth, bans, ownership, policy and CAS behavior without endpoints.

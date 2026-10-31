# STATION membership owner v1 — source contract, inactive by default

Owner: LK community owner; consumers: authenticated LK2 managed GAME JOIN and TRAINING registration.
This packet does not install endpoints, provision a signer, change live configuration,
or authorize deployment. The producer supplies each verified activity/registration binding.

## Wire bytes (frozen v1)

Both routes are POST:

- `/lk/integrations/v1/station-memberships/operations/:operationId/admission`
- `/lk/integrations/v1/station-memberships/operations/:operationId/confirmation`

Admission body (exact keys):

```json
{"contractVersion":1,"operationId":"uuid","requestSha256":"sha256:64-lower-hex","activity":{"kind":"GAME","id":"canonical-game-uuid"},"stationId":"owner-station-id"}
```

Confirmation body (exact keys):

```json
{"contractVersion":1,"operationId":"original-operation-uuid","admissionId":"uuid","admissionBindingSha256":"sha256:64-lower-hex","confirmation":{"kind":"GAME_PARTICIPATION","generationId":"participation-uuid","activityId":"canonical-game-uuid"}}
```

TRAINING uses the same v1 keys/routes/signature: admission `activity.kind=TRAINING`,
`activity.id=<canonical training UUID>`; confirmation `kind=TRAINING_REGISTRATION`,
`generationId=<canonical registration UUID>`, `activityId=<same canonical training UUID>`.
The owner checks the exact GAME/GAME_PARTICIPATION or TRAINING/TRAINING_REGISTRATION
pair and activity UUID against immutable admission before claiming a generation.
Unknown kinds and cross-kind reinterpretation are rejected. No cancellation fact removes
membership. Transport requires a persisted confirmed registration, not a user/provider token.

Canonical JSON recursively sorts object keys lexicographically (JavaScript `.sort()`),
retains array order, and uses JSON.stringify for strings/scalars. No whitespace.
`body_sha256 = 'sha256:' + SHA256('station-membership-body:v1' + NUL + canonicalJSON(body))`.
Request maximum: 8192 UTF-8 bytes. IDs are bounded to 200 ASCII `[A-Za-z0-9._:-]`
characters, first alphanumeric; UUIDs are lowercase; hashes are lowercase.

Header `X-Station-Membership-Delegation` contains RS256 JWT; header exact keys
`alg,kid,typ`, with typ `phub-station-membership-delegation+jwt`.
Common claims (exact keys plus mode-specific keys below):
`iss,aud,sub,jti,iat,nbf,exp,tenant_id,provider_client_id,provider_mapping_id,operation_id,caller,scope,method,path,body_sha256,correlation_id,contract_version`.
`sub` is canonical user UUID; provider_client_id is verified LK member ID.
Tenant, mapping, operation and jti are UUIDs. `contract_version=1`, `method=POST`;
path includes the exact operation UUID. `X-Correlation-ID` equals correlation_id.

Admission adds `sid` (authenticated session UUID), `fresh_operation:true`,
`adoption_version:1`; caller `lk2-api`; scope `communities.station-membership.admit`.
The signer may issue this only for a NEW original registration before its first
attempt/dispatch. Existing/pre-adoption commands without a marker cannot be upgraded.
Receiver trusts this narrow signed server assertion, never browser identity.

Confirmation adds `persisted_fact:true`; caller `lk2-api` or `lk2-worker`;
scope `communities.station-membership.confirm`. No sid, user/Viva token, or provider read.
The signer loads the original admission and exact confirmed participation from durable
owner state; a reconcile command ID never replaces original operationId.

Signature configuration reuses the existing booked-operation public-key/issuer/key-id
variables: `LK2_BOOKED_OPERATION_DELEGATION_{ISSUER,KEY_ID,PUBLIC_KEY_PEM}`.
Audience is separately required: `LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE`.
Maximum JWT lifetime 120 seconds, clock skew 5 seconds. No existing booked-operation
token is accepted. A new short-lived transport JWT may deliver the same immutable fact.
No worker signing provision is asserted by this source packet.

Admission response: `{contractVersion:1,operationId,admission:{outcome,admissionId,communityId,membershipEpoch,reason,bindingSha256},replayed}`.
Confirmation response: `{contractVersion:1,operationId,outcome,reason}`. Outcomes:
`ENROLLED`, `ALREADY_APPLIED`, `NOT_ENROLLED`. No private actor data is returned.
Transport/storage ambiguity is 503, not enrollment success. Booking never rolls back.

Admission outcome is `ADMITTED` only for reason `ELIGIBLE`, otherwise `NO_ENROLLMENT`.
Negative reasons: `STATION_COMMUNITY_MISSING`, `STATION_COMMUNITY_AMBIGUOUS`,
`STATION_POLICY_INVALID`, `ACTOR_MAPPING_CONFLICT`, `MEMBERSHIP_BLOCKED`,
`BAN_IDENTITY_UNRESOLVED`. `communityId` is null for zero/ambiguous selection or invalid
community id, otherwise the selected id. `membershipEpoch` is null for zero/ambiguous
selection or invalid policy, otherwise a nonnegative safe integer (including blocked).

## Durable ownership and replay

`lk_station_membership_admissions`: immutable per-operation document, `_id` =
`v1:<tenantUuid>:<operationUuid>`, including negative zero/ambiguous-selector outcomes.
`admissionId` = first 32 hex digits of SHA256(`station-membership-admission-id:v1` + NUL +
canonicalJSON({tenantId,operationId})), UUID version nibble 8 and RFC variant nibble.
Binding core is `{contractVersion:1,actor:{tenantId,canonicalUserId,playerId,providerMappingId},operationId,requestSha256,activity,stationId,admissionId,outcome,communityId,communityIdentity,policyRevision,membershipEpoch,reason}`.
Private `communityIdentity` is `{type:'objectId'|'string',value}` from the selected Mongo
`_id`, or null for negative selection. It distinguishes delete/recreate with the same
public community id. The wire hash remains opaque and response keys are unchanged.
`bindingSha256` hashes domain `station-membership-admission:v1` + NUL + canonical core.
No timestamps participate in the decision or immutable binding.

The per-operation candidate is persisted first, including original epoch and Mongo
identity. Candidate presence alone is not positive admission. Before returning ADMITTED,
the receiver initializes existing private lifetime `{version:1,revision:0,players:[]}`
with exact `_id`/type/policy/roster/absence CAS and verifies it by readback. Failure is
503; changed identity/policy/epoch is 409. Retry uses only the immutable captured
candidate, never a newer epoch. Confirmation requires that exact Mongo identity and
existing lifetime barrier. This also protects admission-before-first-confirmation when
the feature is later disabled: CUP cannot delete an already admitted identity.

`lk_station_membership_generation_claims`: permanent first-wins `_id` =
`v1:<tenantUuid>:<encodeURIComponent(communityId)>:<confirmationKind>:<generationUuid>`.
Kinds are GAME_PARTICIPATION or TRAINING_REGISTRATION. Existing GAME keys and claim
document bytes remain compatible; the same UUID in different kinds has separate claims.
Claim binds actor, original operation/admission/hash/activity/epoch. Never release or
reassign it. Claim ACK alone proves neither membership nor success.

`lk_communities.stationMembershipLifetime` is private:
`{version:1,revision,players:[{playerId,canonicalUserId?,epoch,state,lastApplied?}]}`.
`lastApplied` contains operationId/admissionId/generationId; TRAINING adds
`kind:TRAINING_REGISTRATION`. Missing kind retains the existing GAME meaning. LEFT, REMOVE, BAN and
explicit administrative restore advance per-player epoch atomically with roster.
Confirmation consumes its permanent claim and checks exact current epoch/status, policy,
identity and roster CAS before appending membership; readback must prove actual ACTIVE
membership and exact lastApplied. Cancellation retains membership. All scoped writers
preserve private fields; no global fixed admission budget or evictable generation list.

## Activation, capacity, and evidence

`LK_STATION_MEMBERSHIP_LIFETIME_ENABLED=true` is the one new source flag, default off.
Owner: root integration. Enable only coherently after LK/CUP writers, producer journal,
delivery signer, unique existing STATION selector, route guards and physical Mongo CI
proof pass. Review/remove the flag at full migration acceptance. Until then LK1 behavior
is unchanged. Once enabled, legacy scan facts cannot synthesize admission or return users.

Missing owner/signing/mapping/selector is NO_ENROLLMENT or unavailable, persisted by the
original producer; never a reason to retry booking. Existing commands without adoption
must remain permanently ineligible. No credentials, new indexes, backfill or live
configuration are created by this packet. Default Mongo `_id` uniqueness is sufficient.

Admission/claim rows are bounded by strict input sizes and retained permanently.
Community roster/lifetime still shares Mongo's document limit: measure target capacity
and prove every live writer before activation. No soft player cap may block terminal
removal/leave. Actual storage failure cannot be reported as a successful leave/enrollment.
CI must exercise independent clients and ACK loss before/after community CAS, including
leave between CAS and readback. Local synthetic tests are not physical Mongo proof.

The existing create/upsert writer is also guarded: an atomic update pipeline preserves
the actual stored row when any lifetime field exists (including malformed/null, any type)
or when the enabled flag protects an existing STATION. All create responses and derived
writes wait for acknowledged upsert/modification. No filtered-upsert duplicate is created.
CUP hard delete rejects protected identities and fences absent lifetime/current type.
Any archival needs a separately approved existing operational procedure; this source
does not add an archive UI/route. Historical identity must not be recreated.

Mongo operations inherit the existing client's write/read concern. The standalone Mongo8
CI fixture proves atomic conflict/replay behavior only, not replication/failover durability.
Before activation, the owner must attest the actual client/server durability policy and
recovery semantics; this packet neither configures majority concern nor claims that proof.

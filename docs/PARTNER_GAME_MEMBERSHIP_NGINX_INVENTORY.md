# Partner Nginx: bounded read-only inventory, 7 September 2026

Latest result: **DISK INCLUDE INVENTORY COMPLETED / NOT PRODUCTION VERIFICATION**.
All literal include targets discovered by the bounded scanner were read; this is
not a full Nginx semantic/dependency graph or proof of applied configuration.
This records observations, not an installed Partner API, an approved private
binding or a deploy authorization. Earlier partial captures remain below.

The user separately authorized this read-only SSH stage after choosing
`partner-api.padlhub.su` on `lk-primary-147`. The coordinator reported no conflicting
server/ingress writer. The existing branch/worktree was retained at source checkpoint
`97a3038`; no production code, policy JSON or immutable release receipt was changed.

## Historical first capture and its limits

| Scope | Actual observation | Limit |
| --- | --- | --- |
| Service/process, 03:27:42 UTC | `nginx.service` active/running, no control process; one master and four workers; executable `/usr/sbin/nginx`; unit `/usr/lib/systemd/system/nginx.service`, no reported drop-ins | Metadata, not proof of loaded config |
| Listeners | Nginx owns host-namespace listeners on 80/443; no listener on 18894 in that snapshot | No external connectivity/firewall probe; this does not establish absence in other namespaces |
| Other relevant port | A non-Nginx listener on 1880 is bound to a non-loopback wildcard address | Process ownership and external reachability were not investigated; do not relabel this as confirmed Node-RED exposure |
| Build paths, 03:30:16 UTC | Nginx 1.24.0; main config `/etc/nginx/nginx.conf`, prefix `/usr/share/nginx`, modules path `/usr/lib/nginx/modules`; default master arguments observed | `nginx -V` only, not `-t/-T`; this step checked boot/master-start/child-PID set and pathname binary, not every worker start epoch |
| Main config on disk | Includes MIME types, two observed PadlHub `conf.d` files, and a sites-enabled glob; that glob resolves to the selected PadlHub config plus six other names | Other vhost/backup contents were outside the exact read scope |
| Config names | `sites-enabled` contains ordinary vhost names and non-hidden backup/pre-release names; directory metadata collection later stopped at an unsupported basename shape in `sites-available` | A matching filename is not proof that its bytes are loaded by workers; no file was removed or renamed |
| PadlHub config | The private bounded scanner reached `/etc/nginx/sites-enabled/padlhub.su`, then returned `UNBALANCED_CLOSE` at line 465 | A scanner limitation or syntax discrepancy, **not a finding that Nginx configuration is invalid**; no native validation was performed |
| Closing readback, 03:48:44–45 UTC | Original host/boot, master/worker parent/start/executable identities matched; main and PadlHub config hashes matched the earlier scoped capture | Stable endpoints of this observation, not an atomic/full-tree snapshot or proof that no transient change occurred |

The main config SHA-256 was
`48c6a4ec1e1fd28ccf968490f07e34a1d7f755793b2108a3ed8670b1ee2a0aa2`;
the selected PadlHub config SHA-256 was
`0fde6859932324136cd5b86ec08a410e4eebba2fd633f3cfc499b3099dfd3d63`.
These are historical observations, not new production pins or release receipts.

## Scope and actual checks of the first capture

- Five config files were opened through an exact allowlist: main config, MIME types,
  `lk_tournament_history_log.conf`, `lk_tournament_participants_guard.conf` and the
  selected `sites-enabled/padlhub.su`. Unrelated vhost/backup contents were not read.
- No private keys, credential/environment files, client logs or shared flows were
  opened; certificate/key/log references were not followed. No Mongo/Viva calls,
  HTTP/TLS probes, DNS changes, installs, `nginx -t/-T`, reload/restart, push, merge,
  deployment or activation occurred. All diagnostic SSH processes exited.
- Local metadata redaction: 8 assertions PASS. Local config lexer/path checks:
  13 assertions PASS. Synthetic fd/ancestor/race checks: 7 scenarios PASS.
  Script syntax checks passed. These checks do not cover the unrecognized live
  config construction and are not native Nginx/runtime/API tests.
- Security review found a post-hoc deadline P2 in the first metadata helper.
  That completed capture took 127 ms; its original source identity was retained.
  Subsequent helpers used monotonic checks and server-side TERM/KILL deadlines.
- Before any config-content read, review found and closed two P1 risks: a path/open
  race and an overbroad filename allowlist. The executed helper used exact paths,
  root-owned non-writable ancestors, checked symlink chains, `O_NOFOLLOW`, same-fd
  pre-read checks and repeated fd/path checks. Read-only re-review found no remaining
  P0–P2 in this limited scope. This does not cover a compromised root or grant an
  absolute filesystem-history guarantee.
- The config collector's incomplete result did not reach its final epoch check.
  The separate closing readback is recorded separately; it does not convert that
  failure into a successful config scan.

## Line-465 scanner discrepancy resolved, not Nginx validation

The continuation after `b678973` retained the same branch/worktree and the
coordinator's non-conflicting read-only window. The bug was in the private lexical
scanner: it treated `#` inside an unquoted token as the beginning of a comment.
For a regex such as the **synthetic** `^/a/[^/?#]+$`, this discarded the rest of the
line, including an opening block brace. The eventual closing brace was then
incorrectly reported as unbalanced. The Nginx 1.24 token reader starts a comment
only in its token-start (`last_space`) branch, not inside that word.
[Official Nginx 1.24 source](https://github.com/nginx/nginx/blob/release-1.24.0/src/core/ngx_conf_file.c#L618-L714).

At 05:54:55 UTC, one guarded A/B read of the same exact PadlHub config hash above
reproduced the legacy `UNBALANCED_CLOSE / 465`; changing only this lexical rule
produced 307 statements. Redacted diagnostics identified affected token lines 53
and 370 and the boolean `hashInCharacterClass: true`, without returning the tokens
or raw lines. Host/boot/process identities and the exact file hash matched before
and after. This was a scanner diagnostic, not a native Nginx grammar check.

The fix is now in [the bounded lexical module](../scripts/partner_game_membership_nginx_lexical.mjs),
with [31 synthetic regression tests](../scripts/tests/partnerGameMembershipNginxLexical.test.mjs).
It has no I/O or production-verifier wiring. Limits are 128 KiB UTF-8 input,
50,000 tokens including punctuation and depth 256; rejected input produces fixed
error codes/line numbers. Returned token values are **private intermediate data**:
only a separate allowlisted projector may emit selected metadata. Do not log or
serialize the complete return value. This intentionally limited lexer is neither
a generic Nginx parser nor an applied-config verifier.

### Corrected scoped capture

At 05:59:55 UTC, a fixed one-shot helper embedding the exact checked-in lexer source
completed with SSH exit 0, final epoch checks and state
`SCOPED_DISK_CONFIG_INVENTORY_NOT_APPLICATION_PROOF`. The original exact-path,
ancestor/symlink, same-fd race checks and server TERM/KILL deadline were retained.
Six files were read: the original five plus the explicitly allowed public
`/etc/letsencrypt/options-ssl-nginx.conf` included by the PadlHub config.
Certificate/key references were counted, **not followed**. Main and PadlHub hashes
remained the same as the first capture.

`graphCoverage: PARTIAL_SCOPED_READ`; six other vhost/include targets remain
outside the read scope. No exact Partner hostname or 18894 upstream was observed
in the scanned statements; this says nothing about unread targets or loaded
configuration. Neither successful tokenization nor unchanged disk/process
observations prove what configuration workers applied.

- Targeted tests: **31/31 PASS**. Scoped ESLint and payload syntax/self-checks PASS.
- Full sequential Partner suite: **731 tests / 707 PASS / 24 FAIL / 0 skipped**,
  actual exit 1. All 24 failing names match the previous 700-test baseline; no new
  failing names. Historical proof/source pins were not resealed. Release gate RED.
- Root `npm run lint`: actual exit 0, **0 errors / 387 warnings**. Root build was
  not rerun: the previously missing 17 VITE inputs remain an unclosed build gate.
- Read-only security review: no P0–P2 findings in the bounded scanner/diagnostic
  scope. This is not a security review of Nginx or a live ingress acceptance.
- No server/provider/shared-data writes, key/cert/env/client-log reads, network
  probes, `nginx -t/-T`, reload/restart, push, merge, deploy or activation. Both SSH
  operations completed; the local heavy-test window was released after lint exit.

## Remaining literal include targets: completed read-only continuation

After the user's separate approval following `65a5b2e`, the coordinator confirmed
no assigned conflicting server/ingress writer. A reviewed one-shot helper extended
the exact read allowlist by the six previously observed non-hidden vhost/include
targets and three exact symlink destinations. Each destination string matched its
previously captured path hash before the SSH run; arbitrary directory contents
were not admitted. The six original config hashes and all three glob target sets
were fixed preconditions, not refreshed automatically on drift.

Actual remote window: **7 September 2026, 06:23:52.306–06:23:52.428 UTC**, SSH exit
**0**. The collector retained root/non-writable ancestor checks, bounded symlink
chains, `O_NOFOLLOW`, same-fd pre/post checks, config rechecks, host/boot/process
identity checks before and after, and the external 20-second TERM/2-second KILL
deadline. All checks completed. State:
`SCOPED_DISK_CONFIG_INVENTORY_NOT_APPLICATION_PROOF`, graph coverage
`ALL_DISCOVERED_LITERAL_INCLUDES_SCANNED_LEXICALLY_ONLY`, skipped targets **0**.

| Disk scope | Files actually scanned | Meaning |
| --- | ---: | --- |
| Main config and MIME types | 2 | Fixed entrypoint and data include |
| Previously observed PadlHub `conf.d` files | 2 | Same hashes as the prior capture |
| Selected PadlHub vhost | 1 | Same hash, 307 statements |
| Previously unread vhost/backup targets | 6 | Three exact leaf symlinks resolved; unrelated names are redacted |
| Shared public TLS-options include | 1 | Reused by seven vhost configs; cert/key references not followed |
| **Total** | **12** | **1,235 lexical statements; no skipped discovered literal includes** |

The sites-enabled glob still matched two non-hidden backup/pre-release PadlHub
files. Both contain literal PadlHub server-name/listen declarations. They were
read, not deleted, renamed or excluded. Matching the on-disk glob does not prove
which virtual server wins or that a future reload succeeds. Their custody must
remain in the later controlled-application/rollback preconditions; any cleanup
requires a separate reviewed change, not an implicit Partner installation step.

No exact `partner-api.padlhub.su` server-name token, literal
`proxy_pass http://127.0.0.1:18894` or `ssl_verify_client` statement was observed
in this bounded lexical projection. This is **not** proof of the absence of an
indirect/named upstream, external TLS termination or routing in loaded memory.
The planned URL must still not be represented as operational.

### New helper checks and evidence custody

- Before SSH, review identified a P2: a quoted structural directive name could
  be silently skipped. The helper now rejects quoted `include`, `server_name`,
  `listen`, `proxy_pass`, `ssl_verify_client` and `load_module` heads. It does not
  broaden the generic lexer or claim to implement Nginx grammar. Nginx resolves
  directive names from token values; see the
  [official token/handler implementation](https://github.com/nginx/nginx/blob/release-1.24.0/src/core/ngx_conf_file.c#L334-L381).
- **31 new synthetic helper assertions PASS**: exact target admission, fixed glob
  set and original-pin drift rejection, private-path aliasing, unknown-field
  omission, quoted structural-head rejection and sensitive-path denial. These
  are separate from the 31 checked-in lexer tests run at the previous checkpoint.
- Existing 13 scanner/path assertions and 7 synthetic fd/ancestor/race scenarios
  also passed for the changed one-shot helper; syntax check PASS. These tests do
  not access a host, a real secret or a network service.
- Re-review: P0–P2 = 0 in the bounded helper scope. Records use explicit metadata
  fields; unknown top-level/include fields are not exported. Raw tokens and
  unrelated domains are not included in the output; cert/key/env/client-log
  contents were not opened. The private source and redacted working capture are
  retained outside Git, with executed source SHA-256
  `8c2477662d5610837eed981db6a1e087848f5075676aed1b4956de25062ffdfd`.
- No repository runtime source, policy/binding or immutable release pin changed.
  Full Partner tests/lint/build were not rerun for this documentation-only repo
  diff. The previous **707 PASS / 24 FAIL** and lint **0 errors / 387 warnings**
  remain historical results, not new executions. Native rehearsal remains deferred.
- No HTTP/TLS/DNS probes, native `nginx -t/-T`, reload/restart, server/provider/shared
  data writes, secret changes, installs, push, merge, deploy or activation occurred.
  The SSH process exited; the coordinator was notified and no resources are held.

## Remaining work

1. **Closed locally:** the line-465 scanner bug is reproduced, fixed and covered by
   synthetic regressions; the corrected scoped capture completed. No production
   config repair or removal was necessary or authorized.
2. **Closed for the bounded disk inventory:** all discovered literal include
   targets were scanned. The six-target gap is resolved; preserve this capture as
   historical evidence and refresh it before any separately approved live transition.
3. Next local slice: connect the existing Nginx candidate/collector design to a
   production adapter contract using the observed entrypoint and exact file custody,
   without replacing the existing implementation. Specify tests for candidate/base
   drift, unchanged shared vhosts (including backup targets), generation change,
   failure/recovery and redacted audit. Do not enable the production entry merely
   because inventory is complete. Exact TLS/mTLS/custody inputs, trusted application
   operator, external vantage and route isolation still need evidence and authority.
4. Retain fresh runtime/packet proof, exact-head CI, separately authorized deploy
   and activation gates. Native application rehearsal remains
   `DEFERRED_BY_USER / NOT_RUN`; no new partner signoff is required.

`verifyPartnerProductionIngress()` remains `UNSUPPORTED_INGRESS_ADAPTER`; ingress and
custody remain `UNBOUND`, activation remains `BLOCKED`. The planned hostname must not
be sent to the partner as a working production endpoint on the basis of this inventory.

Related: [production controls](PARTNER_GAME_MEMBERSHIP_PRODUCTION_CONTROLS.md),
[ingress verifier](PARTNER_GAME_MEMBERSHIP_INGRESS_VERIFIER.md),
[existing evidence diagram](assets/partner-game-membership-ingress-evidence.drawio).

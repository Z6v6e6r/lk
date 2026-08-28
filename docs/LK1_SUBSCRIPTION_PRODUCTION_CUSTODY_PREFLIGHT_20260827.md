# LK1 subscription production custody preflight — 2026-08-27

Status: source-only R4 custody alignment with a proven runtime `STOP`. This work does
not authorize or perform release upload/install, host provisioning, secret access or
provisioning, MongoDB connection or migration, writer quiescence, Node-RED flow import
or restart, provider call, payment, booking, Deploy, or rollback.

## Frozen source identities

- task base: fresh `origin/main` `bbc82cf2ed537bc90d2fe4a19aa4eb3c33b93ed5`;
- read-only live flow SHA-256: `9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263`;
- live node count: `4762`;
- selected `LK Games` tab: `4b91e2a2413688db`, `315` nodes;
- selected-tab SHA-256: `5deb5beca55441bf29da036495304d7a707158c2af87fe88838f68befd6ff78e`;
- reviewed unified candidate SHA-256: `703c065429bcee016e86ac7559c3b834754bab61bcb5c70f4da55b1cc32064ca` (supersedes `928a7c49…`);
- candidate inventory: `4812` nodes, `215` unchanged HTTP inputs, `54` changed
  existing nodes, `50` additions, broken wires/links `0/0`;
- production trust anchor: `UNBOUND`.

The production runner, immutable release source manifest and writer-registry
provenance must use the same current identities. The preceding
`14b5aff6… -> d88ea0af…` runner pair and selected-tab identity `33c676b3…` are
historical and fail closed.

The writer registry provenance binds the byte-preserving selected-tab extraction used
for writer audit; the activation manifest separately binds both that extraction and the
final unified candidate. The two cleanup entries explicitly classify both the active and candidate
function bodies as generated flow evidence, because the tracked source files contain
candidate bodies while the active flow still contains their older exact preimages.
No writer is exempted, and the required revision/CAS tokens and graph relations remain
mandatory. Substituting final unified postimages into the writer contract fails the
fresh builder closed. The immutable release builder packages the activation manifest
and rejects any runner, manifest, selected-tab provenance, tab identity, node-count or
seven-writer coverage mismatch before it creates a release manifest.

## Read-only target preflight

Presence-only checks on `lk-primary-147` established:

- Node.js `v22.23.2`, npm `10.9.8`, and the existing root-owned PM2 `node-red`
  process are present;
- the installed Node-RED MongoDB dependency reports version `3.7.4`;
- `/opt/padlhub/legacy-game-command`, the custom-node package/runtime locations,
  and the protected runtime context location are absent;
- the required unprivileged executor user and group are absent;
- all three required subscription runtime configuration names are absent from the
  inspected PM2 environment and `settings.js` references.

Only presence booleans were read for configuration names. No secret value was read
or logged. No MongoDB connection or remote write was attempted.

## Fail-closed decision

Production migration and Deploy remain `STOP` because:

1. the canonical Ed25519 trust-anchor manifest remains `UNBOUND` and no independently
   approved key ID, public SPKI fingerprint, external private-key custody evidence,
   or rotation/revocation owner was supplied;
2. the dedicated unprivileged executor, group, protected release path and custom-node
   runtime are not installed;
3. the three subscription runtime configuration bindings are absent;
4. database audit/dry-run, exact target fingerprint, backup/restore rehearsal,
   writer quiescence, runtime-closure attestation and signed execution packet do not
   exist for this source identity.

Inventing a key or provisioning any host/runtime state would cross separate R4 live
gates. The source alignment in this task makes the immutable offline release internally
coherent, but it is not executable authority and cannot change this verdict.

## Required future gates

Any future continuation must separately freeze fresh pushed-main/CI and live-flow
identity, receive an externally governed trust-anchor binding, approve and verify host
hardening and release installation, provision protected runtime configuration without
logging values, complete database audit/dry-run plus backup/restore/quiescence evidence,
and only then request exact authorization for migration apply and later Deploy. Drift or
missing evidence at any gate is `STOP`.

# Legacy startup retirement candidate

Owner: Node-RED backend. Audience: operators reviewing legacy startup retirement.
The offline composer removes only the approved cohort: four orphan Telegram config
nodes, the isolated manual/debug email chain and its sole transport, and the
placeholder workflow counter chain, including startup/cron/manual update paths.
This is a candidate builder, not an import, installer, workflow dispatch or restart.

`scripts/prepare_legacy_startup_retirement.mjs` exports
`composeLegacyStartupRetirement(sourceBytes, { expectedSourceSha256 })`.
It returns candidate bytes and a receipt containing only hashes, role names and counts.
Production bindings contain identity/preimage hashes, never private flow bodies,
addresses, URLs, account values or raw node identifiers. Tests use synthetic bindings.

The source SHA must be separately reviewed. Every one of the 14 exact node preimages
must match. Any retained node referring to a removed identity (including nested config,
links, environment values and source literals) stops preparation. The already declared
TypeScript parser checks retained function/lifecycle bodies without executing them.
Runtime `RED` references and `getNode` identifiers/string members require review,
including bracket, template-member and optional-chain syntax; comments and color
property labels do not. A `RED` reference is allowed only when the parser/checker
resolves it to a local const primitive (for example an ANSI color); shadowing and
runtime-valued aliases remain blocked. Direct static `RED.nodes.createNode` and
`RED.nodes.registerType` constructor calls are allowed; these do not look up an
existing config. Passing out the registry, computed method selection and node lookup
remain blocked. A fresh read-only AST check found only these constructor operations
in the retained runtime source that matched the earlier broad regex.
The checker uses one in-memory file with
no libraries or module resolution and never evaluates retained source.
This conservative static gate is not a proof about arbitrary obfuscated JavaScript;
new runtime lookup mechanisms require investigation, not bypassing the gate.
All retained nodes, HTTP inputs, tabs, other bot configs and order remain unchanged.
The composer never edits credentials, triggers a provider, or repairs inbound edges.

## Validation

```sh
node --test scripts/tests/legacyStartupRetirement.test.mjs
```

Coverage includes the complete removal, configured bot preservation, inbound wire/
config/link/nested/source references, dynamic lifecycle lookups, target/source drift,
missing and duplicate IDs, incomplete/aliased bindings and source immutability.

## Activation hold

Before any separately authorized apply, pull a fresh live preimage to a new private
external workspace with the existing `nodered:modular:pull-147` workflow and verify it.
Never publish raw source/candidate files or fabricate freshness metadata. Re-run the
composer against that source; any target/dependency drift stops the affected cohort.
Keep its original bytes and reviewed source/candidate hashes in the private packet.

The existing `exact-graph` deploy contract deliberately rejects node removals. This
retirement receipt does **not** relax it and must not be passed to that installer as
an approved deploy contract. The separate format-v3 retirement contract and guarded
runner are documented in [the apply/recovery runbook](LEGACY_STARTUP_RETIREMENT_APPLY.md).
Their inclusion prepares a release mechanism; it does not authorize activation.

Expected result after an authorized activation: the retired constructors/triggers
are absent, while retained graph/config values match the reviewed candidate.
Absence of warnings alone does not establish closure. No real messages or workflow
updates should be replayed as a test. A rollback must not silently reactivate the
retired external writes; stop and obtain an explicit recovery decision if restoration
of the original flow would do so. This Draft PR does not claim a production fix.

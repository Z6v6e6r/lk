# Function 296 safe request-preparation diagnostic

Function 296's daily 18:30 inject prepares a Bitrix deal-list GET request. Its
unconditional warning prints the full URL, including a credential-shaped webhook
segment and query data. Replace only that warning with the existing constant event:

```json
{"event":"bitrix_deal_list_request_prepared","provider":"bitrix","operation":"deal_list","phase":"request_preparation"}
```

This event describes request preparation. It makes no claim about provider success.
The URL, returned message, GET node, inactive debug node, inject schedule, `once:false`,
and all wiring remain unchanged. No endpoint or external operation is added.

The source-driven patcher pins the diagnosed source and hashed node identity. It
requires one enabled target, its daily inject, GET/object-response HTTP node and an
explicitly inactive debug node. It refuses ambiguity, drift, repeat application and
unsafe boundaries. The existing exact-graph contract permits only that node's `func`
field to change; no full source, generated flow or candidate belongs in Git.

```bash
node --test scripts/tests/function296SafeDiagnostic.test.mjs
node scripts/patch_live_function296_safe_diagnostic.mjs \
  --workspace /absolute/private/external/live-workspace \
  --expected-flow-sha256 <reviewed-whole-flow-sha256>
```

The CLI verifies the existing private, fresh source workspace. By default it prints
only safe hashes/counts/booleans. Optional `--output` writes a new candidate exclusively
to an external canonical directory with mode 0700; the file is 0600, with no overwrite
or aliasing. Errors are constant and never quote source, paths or parser details.
The patcher never connects to Node-RED, imports, deploys or restarts a process.

Owner: LK backend maintainer; audience: operators reading Node-RED diagnostics.
Expected result: one constant warning without URL/query/payload disclosure. Stop on
source, schedule, HTTP or debug drift by refusing candidate construction; do not weaken
the pins. Before any separately authorized apply, pull and review a fresh preimage.
This change does not remove historical logs, rotate credentials or resolve other sinks.

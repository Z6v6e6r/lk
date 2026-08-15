# Viva User-Agent

## Contract

All PadlHub server-side HTTP calls to Viva use one stable identifier:

```text
User-Agent: PadlHub-LK/1.0
```

The value is deliberately static. It identifies the integration for Viva logs,
rate-limit diagnostics and support incidents; it is not a frontend build number.
It contains no token, phone, client ID, booking ID or other personal data.

## Coverage

The contract is applied in two places:

1. Node-RED `http request` nodes connected to a configured URL or bounded
   upstream node containing an exact `vivacrm.ru` host or subdomain.
2. Repository maintenance/repair scripts that use Node.js `fetch`.

The Node.js wrapper adds the header only when the parsed destination hostname is
`vivacrm.ru` or ends in `.vivacrm.ru`. Lookalikes such as
`api.vivacrm.ru.example.org` are rejected.

The browser bundles are intentionally outside this guarantee. A browser owns
its network `User-Agent` behavior, and adding a custom browser header can also
change CORS/preflight requirements. Browser requests continue to be attributed
through the existing tenant, OAuth client and Viva request context.

## Guarded Node-RED candidate

Always start from a new verified live workspace from `lk-primary-147`:

```bash
npm run nodered:modular:pull-147 -- \
  /private/tmp/lk-viva-user-agent-live-YYYYMMDD

npm run nodered:viva-user-agent:patch -- \
  --workspace /private/tmp/lk-viva-user-agent-live-YYYYMMDD \
  --output /private/tmp/lk-viva-user-agent-candidate-YYYYMMDD/candidate.json \
  --report /private/tmp/lk-viva-user-agent-candidate-YYYYMMDD/report.json
```

Both directories must be new and outside the repository. The patcher:

- verifies origin, SHA-256, private permissions and freshness (at most 30 minutes);
- discovers Viva request nodes from URL evidence, never from a display name alone;
- follows at most eight upstream edges and stops at another HTTP Request boundary;
- preserves every existing configured header and appends only the fixed
  `User-Agent` descriptor;
- fails on duplicate/dynamic/conflicting `User-Agent` values;
- proves that IDs, wires, links and inbound HTTP routes are unchanged;
- publishes the candidate and redacted report atomically with private permissions.

The command only constructs a local candidate. It does not import flows, restart
Node-RED, deploy code or modify live data.

Some live HTTP Request nodes are shared by Viva and non-Viva branches. The
configured header therefore identifies those shared PadlHub Node-RED requests as
well. The value is generic and non-sensitive; avoiding that would require risky
changes to many business function nodes. The review report lists every affected
request node so this boundary remains explicit.

## Review and verification

Run the focused regression suite:

```bash
npm run test:viva-user-agent
```

For a fresh candidate, verify in the report that:

- `ok` is `true`;
- `userAgent` is exactly `PadlHub-LK/1.0`;
- every `changedNodes[].changedFields` equals `["headers"]`;
- `changedNodeCount + alreadyCompliantNodeCount` equals `discoveredNodeCount`;
- `sharedDestinationNodeCount` and each `nonVivaLiteralHosts` list have been
  reviewed for shared request nodes;
- every display-name-only item in `nameOnlyReviewNodes` has been checked and is
  intentionally excluded without treating its label as routing evidence;
- source and candidate SHA-256 values are present;
- invariant hashes and inbound route count are present.

Deployment is a separate approval gate. Before any later import, preserve a
recoverable live-flow backup and review the complete target list. After import,
make one bounded read-only Viva request and ask Viva to confirm
`PadlHub-LK/1.0` in their access logs. A local candidate alone cannot prove what
the provider received.

## Maintenance scripts

`scripts/lib/vivaUserAgent.mjs` is the only source of the header value and the
hostname guard. Scripts should call `createVivaFetch()` rather than setting the
header independently. Existing `Authorization`, `Accept` and `Content-Type`
headers are preserved; a conflicting caller-supplied `User-Agent` fails closed.

The immutable rating-worker package must include this helper because scheduled
attendance sync imports it at process startup. `npm run test:rating-worker-release`
builds a source-only release, verifies the helper entry and checksum in its
manifest, and proves that the packaged attendance-sync module resolves locally.

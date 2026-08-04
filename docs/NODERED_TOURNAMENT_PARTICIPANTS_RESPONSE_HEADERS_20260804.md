# Tournament participants response-header safety

## Scope

This stage fixes only the response boundary for:

```text
GET /lk/tournaments/participants
```

Touched live node contract:

- tab: `LK Tournaments` (`f9575c8726e29196`);
- function: `Participants cache terminal v2`
  (`lk_tournament_participants_terminal_20260719`);
- downstream response: `afef710ac9f58b69`.

No route, wire, link, cache policy, Viva request, queue, rate limit, participant
mapping, or game state is changed.

## Failure and correction

The terminal could forward upstream `Content-Length` and `Transfer-Encoding`
at the same time. The Node-RED HTTP response node owns response framing, so
nginx could reject the result when Node.js selected its own transfer mode.

The terminal now removes these response-node-owned headers case-insensitively:

- `Connection`;
- `Content-Length`;
- `Transfer-Encoding`.

All other headers, status codes, payloads, cache markers, and stale fallback
behavior are preserved.

## Verified live preimage

The read-only audit pulled the exact source from
`lk-primary-147:/root/.node-red/flows.json` into a private external workspace.

- source SHA-256:
  `cb109f305bf48ff5f6026b5ff0ef944a3cfd49e81da247c757a90f1a880f43a2`;
- nodes: `4673`;
- HTTP inputs: `203`;
- selected `LK Tournaments` nodes: `118`;
- selected HTTP inputs: `11`;
- broken wires: `0`;
- broken links: `0`.

The guarded builder also pins the route, terminal function preimage, response
node, and the complete 20-node graph reachable from this HTTP input.

## Isolated candidate

The guarded builder produced a private candidate outside the repository.

- candidate SHA-256:
  `c47eaf4cde86a8f12909f6bde54c0d7d23389afa5a25ff5a2ec4626fc6d30f69`;
- node count: `4673 -> 4673`;
- HTTP input count: `203 -> 203`;
- changed nodes: `1`;
- changed fields: only `func` on
  `lk_tournament_participants_terminal_20260719`;
- deployment performed: `false`.

No import file is committed or deployed. Candidate and redacted report remain
in the private external publication directory. A future rollout must reverify
the live preimage, take a server-side backup, and stop if the pinned SHA or
graph has drifted.

## Validation

Focused tests cover:

- successful cold response;
- fresh cache hit;
- stale-if-error fallback;
- uncached upstream `502`;
- epoch-change response;
- case-insensitive framing-header removal;
- preservation of cache, CORS, trace, status, and payload data;
- guarded-builder source, route, terminal, response, and topology drift.

Production remains unchanged in this stage. Public endpoint verification is a
deployment post-check and is not represented by the local candidate result.

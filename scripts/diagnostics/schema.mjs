import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diagnosticContract, leaveAssets, leaveActions, leaveKinds } from '../../src/utils/errorDiagnosticsCore.mjs';
export function schemaV1() {
  const id = { type: 'string', pattern: '^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$' };
  const properties = { schemaVersion: { const: 1 }, diagnosticEventId: id, requestId: id };
  for (const [key, values] of Object.entries(diagnosticContract.enums)) properties[key] = { enum: [...new Set([...values, key === 'retriable' ? 'unknown' : key === 'outcome' ? 'outcome_unknown' : 'UNKNOWN'])] };
  for (const key of diagnosticContract.booleanFields) properties[key] = { type: 'boolean' };
  for (const [key, [minimum, maximum]] of Object.entries(diagnosticContract.numericBounds)) properties[key] = { type: 'integer', minimum, maximum };
  for (const key of ['serverTimeUtc', 'serverIngestTime', 'deviceEventTime']) properties[key] = { type: 'string', format: 'date-time', maxLength: 24 };
  for (const key of ['sourceRelease', 'serverRelease', 'callerBuild', 'sourceHash']) properties[key] = { type: 'string', pattern: '^(?:UNKNOWN|[0-9a-f]{40}|[0-9a-f]{64})$' };
  for (const key of ['serverRequestId', 'logicalOperation', 'attemptReference']) properties[key] = id;
  for (const key of ['entityRef', 'operationRef', 'bindingRef', 'outboxRef']) properties[key] = { type: 'string', pattern: '^h1:[0-9a-f]{32}$' };
  properties.correlationHash = { type: 'string', pattern: '^c1:[0-9a-f]{64}$' };
  properties.leaveTrace = { type: 'object', additionalProperties: false,
    required: ['frames', 'actions', 'visibility'], properties: {
      visibility: { enum: ['visible', 'hidden', 'UNKNOWN'] },
      frames: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        required: ['asset', 'line', 'column'], properties: { asset: { enum: leaveAssets },
          line: { type: 'integer', minimum: 0, maximum: 10000000 }, column: { type: 'integer', minimum: 0, maximum: 10000000 } } } },
      actions: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        required: ['action', 'kind', 'ageMs'], properties: { action: { enum: leaveActions }, kind: { enum: leaveKinds },
          ageMs: { type: 'integer', minimum: 0, maximum: 120000 }, trusted: { type: 'boolean' } } } },
    } };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'PadlHub safe diagnostics v1', type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'diagnosticEventId', 'eventKind', 'source', 'routeTemplate', 'method', 'stage', 'code', 'retriable', 'outcome'],
    allOf: [{ if: { properties: { eventKind: { not: { const: 'suppression' } } } }, then: { required: ['requestId'] } },
      { if: { required: ['leaveTrace'] }, then: { properties: {
        source: { const: 'browser' }, eventKind: { const: 'client_error' }, method: { const: 'POST' },
        routeTemplate: { const: '/lk/games/:gameId/split/leave' }, stage: { const: 'leave_initiator' },
        code: { const: 'SPLIT_LEAVE_INITIATED' },
      } } }], properties };
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--write') {
  fs.writeFileSync(new URL('../../docs/diagnostics/schema.v1.json', import.meta.url), `${JSON.stringify(schemaV1(), null, 2)}\n`);
}

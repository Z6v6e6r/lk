import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diagnosticContract } from '../../src/utils/errorDiagnosticsCore.mjs';
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
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'PadlHub safe diagnostics v1', type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'diagnosticEventId', 'eventKind', 'source', 'routeTemplate', 'method', 'stage', 'code', 'retriable', 'outcome'],
    allOf: [{ if: { properties: { eventKind: { not: { const: 'suppression' } } } }, then: { required: ['requestId'] } }], properties };
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--write') {
  fs.writeFileSync(new URL('../../docs/diagnostics/schema.v1.json', import.meta.url), `${JSON.stringify(schemaV1(), null, 2)}\n`);
}

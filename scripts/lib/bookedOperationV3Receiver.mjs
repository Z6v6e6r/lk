// Source-only v3 receiver request layer. A Node-RED HTTP-in/function pair can call this module
// after verifying the actor delegation; the module owns routing, scope/path checks and the exact
// request/response contract. It never creates a checkout or a second ledger.
import { createHash } from 'node:crypto';

import {
  BOOKED_OPERATION_V3,
  buildBookedOperationV3CancelResult,
  buildBookedOperationV3PreflightResult,
  buildBookedOperationV3ReadOutcome,
  parseBookedOperationV3AdmissionRequest,
  parseBookedOperationV3CancelRequest,
  parseBookedOperationV3PreflightRequest,
} from './bookedOperationV3Contract.mjs';

const sha256 = (value) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const reply = (status, body) => ({ status, body });
const fail = (status, code) => reply(status, { error: code, code });

export function createBookedOperationV3Receiver(ports) {
  return {
    async handle(input) {
      // input: { method, path, body, headers, delegationClaims, actorToken }
      const claims = input.delegationClaims;
      if (!claims || claims.contract_version !== BOOKED_OPERATION_V3.contractVersion)
        return fail(401, 'BOOKED_OPERATION_V3_DELEGATION_REQUIRED');
      if (claims.path !== input.path || claims.method !== input.method)
        return fail(401, 'BOOKED_OPERATION_V3_DELEGATION_PATH_MISMATCH');
      const expiresAtMs =
        typeof claims.exp === 'number' ? claims.exp * 1000 : Date.parse(claims.exp);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())
        return fail(401, 'BOOKED_OPERATION_V3_DELEGATION_EXPIRED');

      if (input.method === 'POST' && input.path === BOOKED_OPERATION_V3.preflightPath) {
        if (claims.scope !== BOOKED_OPERATION_V3.scopes.preflight)
          return fail(403, 'BOOKED_OPERATION_V3_SCOPE_MISMATCH');
        let request;
        try {
          request = parseBookedOperationV3PreflightRequest(input.body);
        } catch {
          return fail(400, 'BOOKED_OPERATION_V3_REQUEST_INVALID');
        }
        const result = await ports.preflight({ claims, request, actorToken: input.actorToken });
        return reply(
          200,
          buildBookedOperationV3PreflightResult({
            operationId: claims.operation_id,
            action: request.action,
            target: request.target,
            quote: result.quote,
            settlement: result.settlement,
            requestSha256: result.requestSha256,
          }),
        );
      }

      if (input.method === 'POST' && input.path === BOOKED_OPERATION_V3.admissionPath) {
        if (claims.scope !== BOOKED_OPERATION_V3.scopes.admit)
          return fail(403, 'BOOKED_OPERATION_V3_SCOPE_MISMATCH');
        let request;
        try {
          request = parseBookedOperationV3AdmissionRequest(input.body);
        } catch {
          return fail(400, 'BOOKED_OPERATION_V3_REQUEST_INVALID');
        }
        if (
          request.quoteId !== claims.quote_id ||
          request.settlementConsent.quoteId !== claims.quote_id
        )
          return fail(409, 'BOOKED_OPERATION_V3_QUOTE_MISMATCH');
        if (sha256(request) !== claims.request_sha256)
          return fail(409, 'BOOKED_OPERATION_V3_REQUEST_HASH_MISMATCH');
        const result = await ports.admit({ claims, request, actorToken: input.actorToken });
        return reply(
          202,
          buildBookedOperationV3ReadOutcome({
            operationId: claims.operation_id,
            quoteId: claims.quote_id,
            requestSha256: claims.request_sha256,
            status: result.status,
            asOf: result.asOf ?? null,
            payment: result.payment,
            booking: result.booking,
            visit: result.visit,
            reason: result.reason ?? null,
            receipt: result.receipt ?? null,
          }),
        );
      }

      const readId = input.path.startsWith(BOOKED_OPERATION_V3.readPrefix)
        ? input.path.slice(BOOKED_OPERATION_V3.readPrefix.length)
        : null;
      if (input.method === 'GET' && readId) {
        if (claims.scope !== BOOKED_OPERATION_V3.scopes.read)
          return fail(403, 'BOOKED_OPERATION_V3_SCOPE_MISMATCH');
        if (readId !== claims.operation_id)
          return fail(409, 'BOOKED_OPERATION_V3_OPERATION_MISMATCH');
        const result = await ports.read({ claims, actorToken: input.actorToken });
        return reply(200, result);
      }

      const cancelId =
        input.method === 'POST' && input.path.endsWith('/cancel')
          ? input.path.slice(BOOKED_OPERATION_V3.cancelPrefix.length, -'/cancel'.length)
          : null;
      if (cancelId) {
        if (claims.scope !== BOOKED_OPERATION_V3.scopes.cancel)
          return fail(403, 'BOOKED_OPERATION_V3_SCOPE_MISMATCH');
        let request;
        try {
          request = parseBookedOperationV3CancelRequest(input.body);
        } catch {
          return fail(400, 'BOOKED_OPERATION_V3_REQUEST_INVALID');
        }
        if (request.operationId !== claims.operation_id || cancelId !== claims.operation_id)
          return fail(409, 'BOOKED_OPERATION_V3_OPERATION_MISMATCH');
        const result = await ports.cancel({ claims, request, actorToken: input.actorToken });
        return reply(200, buildBookedOperationV3CancelResult(result));
      }

      return fail(404, 'BOOKED_OPERATION_V3_ROUTE_NOT_FOUND');
    },
  };
}

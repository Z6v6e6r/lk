import { gamePatchRoute, gamePatchClaims } from '../../src/utils/gamePatchDiagnostics.mjs';

// Pure projection of client claims and trusted server-hook facts. No retained
// requests, bodies, entity IDs, cookies, headers, version values or writes.
export function gamePatchConflictFacts(msg, stage, fields = {}) {
  try {
    const req = msg?.req;
    if (req?.method !== 'PATCH' || !gamePatchRoute(req.path)) return null;
    const raw = req.originalUrl ?? req.url;
    let claims = { callerBuild: 'UNKNOWN' };
    if (typeof raw === 'string' && raw.length <= 4096 && !raw.includes('#')) {
      const query = raw.indexOf('?');
      if (query >= 0) claims = gamePatchClaims(new URLSearchParams(raw.slice(query + 1)));
    }
    const result = { logicalOperation: undefined, ...claims };
    if (fields.httpStatus === 409) {
      if (stage === 'roster_authorize' && fields.code === 'GAME_ROSTER_BINDING_UNKNOWN') result.patchConflictStage = 'binding';
      else if (stage === 'roster_authorize' && fields.code === 'GAME_PATCH_VERSION_CONFLICT') result.patchConflictStage = 'precondition';
      else if (stage === 'roster_ack' && fields.code === 'GAME_PATCH_VERSION_CONFLICT'
        && msg._partnerRosterPatch?.preimage && !msg.error
        && msg.payload?.acknowledged === true && msg.payload?.matchedCount === 0) result.patchConflictStage = 'cas';
      else result.patchConflictStage = 'UNKNOWN';
    }
    return result;
  } catch { return null; }
}

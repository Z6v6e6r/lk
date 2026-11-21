import { createDiagnostics } from './runtime.mjs';
import { gamePatchRoute } from '../../src/utils/gamePatchDiagnostics.mjs';

export const GAME_PATCH_SCOPE = 'GAME_PATCH_409_V1';
const refusal = (stage, fields) => fields?.httpStatus === 409 && (
  (stage === 'roster_authorize' && ['GAME_ROSTER_BINDING_UNKNOWN', 'GAME_PATCH_VERSION_CONFLICT'].includes(fields.code))
  || (stage === 'roster_ack' && fields.code === 'GAME_PATCH_VERSION_CONFLICT'));

// Early route/stage gate keeps already-instrumented unrelated live nodes inert.
// No middleware, keys, headers, entity references or business callbacks.
export function createScopedObserver({ sink, release, detailLimit = 600 } = {}) {
  const diagnostics = createDiagnostics({ release, detailLimit, sink(event) {
    const conflict = event.source === 'node_red' && event.method === 'PATCH'
      && ['/lk/games/:gameId', '/lk/games/records/:gameId'].includes(event.routeTemplate)
      && refusal(event.stage, event);
    const suppression = event.eventKind === 'suppression' && event.code === 'DETAIL_SUPPRESSED'
      && event.aggregate === true && event.suppressedEventKind === 'stage';
    if (conflict || suppression) return sink?.(event);
  } });
  return Object.freeze({ scope: GAME_PATCH_SCOPE,
    observe(msg, stage, fields) {
      try {
        if (msg?.req?.method === 'PATCH' && gamePatchRoute(msg.req.path) && refusal(stage, fields)) {
          diagnostics.observe(msg, stage, fields);
        }
      } catch { /* Logging cannot alter a business operation. */ }
    },
    upstream() {}, transport() {}, media() {}, bindMax() {}, ingestClient() {},
    clientEnvelope() { return null; }, ref() {},
    middleware(_req, _res, next) { next(); },
    snapshot: () => diagnostics.snapshot(), flushSuppressed: () => diagnostics.flushSuppressed(),
    dispose: () => diagnostics.dispose(),
  });
}

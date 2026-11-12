import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sanitizeEvent } from '../../src/utils/errorDiagnosticsCore.mjs';
import { createDiagnosticBudget } from '../../src/utils/diagnosticBudget.mjs';
import { previewEmptyTariffFacts } from './preview-empty-tariffs.mjs';

// Projection boundary for the installed node-local generation. The common
// runtime must not re-extract a deliberately stripped message a second time.
export function createScopedEmptyTariffObserver({ sink, release, sourceHash, detailLimit = 60,
  clock = () => new Date(), monotonic = () => performance.now() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(release || '') || !/^[a-f0-9]{64}$/.test(sourceHash || '')) throw Error('PREVIEW363_SOURCE_REQUIRED');
  const requests = new WeakMap(), budget = createDiagnosticBudget(detailLimit);
  let disposed = false, timer = null;
  const deliver = event => {
    try {
      const pending = event ? sink?.(event) : undefined;
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* The logger cannot affect a business result. */ }
  };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    for (const { kind, count } of budget.drain()) deliver(sanitizeEvent({ schemaVersion: 1,
      diagnosticEventId: randomUUID(), eventKind: 'suppression', source: 'node_red',
      routeTemplate: '/lk/subscriptions/game-price-preview', method: 'POST', stage: 'collector',
      code: 'DETAIL_SUPPRESSED', suppressedEventKind: kind, suppressed: true, aggregate: true,
      suppressedCount: count, serverTimeUtc: clock().toISOString(), sourceHash, sourceRelease: release }));
  };
  return Object.freeze({
    observe(msg, stage, fields) {
      try {
        if (disposed || stage !== 'preview_router' || fields?.code !== 'PREVIEW_EMPTY_TARIFF_OBSERVED'
          || fields.reason !== 'empty_tariff_list' || msg?._subscriptionPricePreview?.step !== 'groupTariff'
          || msg.req?.method !== 'POST' || msg.req.path !== '/lk/subscriptions/game-price-preview') return;
        let requestId = requests.get(msg.req);
        if (!requestId) { requestId = randomUUID(); requests.set(msg.req, requestId); }
        const facts = previewEmptyTariffFacts(msg, stage, fields);
        // Function VMs need not expose URL. Equality to the entire canonical
        // request already proves both components without another parser/import.
        if (facts.tariffRequestScopeMatch === true) {
          facts.tariffTenantScopeMatch = true;
          facts.tariffExerciseScopeMatch = true;
        }
        const event = sanitizeEvent({ schemaVersion: 1, diagnosticEventId: randomUUID(), requestId,
          correlationHash: `c1:${createHash('sha256').update(`lk-preview-request-v1\0${requestId}`).digest('hex')}`,
          eventKind: 'audit', source: 'node_red', routeTemplate: '/lk/subscriptions/game-price-preview',
          method: 'POST', stage: 'preview_router', operationStage: 'groupTariff',
          code: 'PREVIEW_EMPTY_TARIFF_OBSERVED', reason: 'empty_tariff_list', tariffCount: 0,
          httpStatus: 503, outcome: 'refused', sourceHash, sourceRelease: release,
          serverTimeUtc: clock().toISOString(),
          tariffEventIdentityMatch: fields.tariffEventIdentityMatch,
          tariffEventCategoryMatch: fields.tariffEventCategoryMatch,
          tariffEventStartMatch: fields.tariffEventStartMatch,
          ...facts });
        if (!event) return;
        if (!budget.admit(monotonic(), 'audit')) {
          if (!timer) { timer = setTimeout(flush, 1000); timer.unref?.(); }
          return;
        }
        deliver(event);
      } catch { /* No original message/context/provider value is serialized. */ }
    },
    dispose() { disposed = true; flush(); },
  });
}

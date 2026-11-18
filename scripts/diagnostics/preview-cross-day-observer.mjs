import { createDiagnostics } from './runtime.mjs';

export const PREVIEW_CROSS_DAY_OWNER = 'preview-cross-day-v1';
// Deployment adapter only: no middleware, shared context, HMAC key or business reads.
export function createPreviewCrossDayObserver({ sink, release, sourceHash, detailLimit = 600 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash || '')) throw Error('PREVIEW_DIAGNOSTIC_SOURCE_REQUIRED');
  const inner = createDiagnostics({ sink, release, detailLimit });
  return Object.freeze({ owner: PREVIEW_CROSS_DAY_OWNER,
    observe(msg, stage, fields) {
      try {
        if (stage !== 'preview_router' || fields?.code !== 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED'
          || msg?._subscriptionPricePreview?.step !== 'subservices') return;
        // Never give the common observer the original payload/headers/diagnostic context.
        const minimal = { req: { path: '/lk/subscriptions/game-price-preview', method: 'POST' },
          _subscriptionPricePreview: { step: 'subservices' } };
        inner.observe(minimal, stage, { sourceHash, code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED', httpStatus: 503, outcome: 'refused',
          previewTargetKind: fields.previewTargetKind, previewTargetSource: fields.previewTargetSource,
          previewDuration: fields.previewDuration, previewDayRelation: fields.previewDayRelation,
          previewOffsetValid: fields.previewOffsetValid, previewEndAtMidnight: fields.previewEndAtMidnight,
          previewSelectedSubserviceCount: fields.previewSelectedSubserviceCount, previewSubserviceSetSize: fields.previewSubserviceSetSize,
          previewSubservicesMatched: fields.previewSubservicesMatched, previewSubservices2xx: fields.previewSubservices2xx,
          previewElapsedBucket: fields.previewElapsedBucket });
      } catch { /* Observation cannot change the business guard. */ }
    },
    snapshot: () => inner.snapshot(),
    dispose: () => inner.dispose(),
  });
}

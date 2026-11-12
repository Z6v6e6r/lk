import { createDiagnostics } from './runtime.mjs';

export const PREVIEW_VALIDATION_OWNER = 'preview-request-validation-v1';
// Final-node VM adapter: no middleware, shared context, key or business reads.
export function createPreviewRequestValidationObserver({ sink, release, sourceHash, detailLimit = 600 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash || '')) throw Error('PREVIEW_VALIDATION_SOURCE_REQUIRED');
  const inner = createDiagnostics({ sink, release, detailLimit });
  return Object.freeze({ owner: PREVIEW_VALIDATION_OWNER,
    observe(msg, stage) {
      try {
        const ctx = msg?._subscriptionPricePreview;
        if (stage !== 'preview_final' || ctx?.done !== true || ctx.error !== 'PRICE_PREVIEW_REQUEST_INVALID'
          || msg.statusCode !== 400) return;
        // The runtime never receives the original request, target, payload or diagnostic context.
        const minimal = { req: { path: '/lk/subscriptions/game-price-preview', method: 'POST' } };
        inner.observe(minimal, stage, { sourceHash, code: 'PRICE_PREVIEW_REQUEST_INVALID', httpStatus: 400, outcome: 'refused',
          firstFailedValidationPredicate: ctx.firstFailedValidationPredicate, validationFieldShape: ctx.validationFieldShape });
      } catch { /* Observation cannot change the refusal. */ }
    },
    snapshot: () => inner.snapshot(),
    dispose: () => inner.dispose(),
  });
}

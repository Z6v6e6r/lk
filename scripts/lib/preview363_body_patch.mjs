// This module is also embedded in the browser guard. It has no I/O or imports.
export const PREVIEW363_TARGET = 'lk_subscription_price_preview_20260908_router';
export const PREVIEW363_FUNCTION_SHA = '9d5a757b316e76c514487ac0c7b048d1b5fb2dfdb0cea6d80d1f98e2d85aade4';
export const PREVIEW363_ANCHOR = "    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');\n";
export const PREVIEW363_HOOK = `    if (reason === 'empty_tariff_list') {
      const binding = {};
      try {
        // Comparisons only, with no new reads or changes to the decision. The
        // shared observer inspects the already-read tariff reply before stop.
        if (canonical.isObj(ctx.exercise)) {
          const identity = ctx.exercise.id || ctx.exercise.exerciseId;
          if (typeof identity === 'string' && identity) binding.tariffEventIdentityMatch = identity === ctx.exerciseId;
          binding.tariffEventCategoryMatch = canonical.resolveCategory(ctx.exercise) === eventRoute?.category;
          const eventStart = Date.parse(canonical.eventStartsAt(ctx.exercise));
          const targetStart = Date.parse(ctx.target?.startsAt);
          if (Number.isFinite(eventStart) && Number.isFinite(targetStart)) binding.tariffEventStartMatch = eventStart === targetStart;
        }
      } catch { /* Missing comparison evidence stays unknown. */ }
      lkDiagnostic({ eventKind: 'audit', code: 'PREVIEW_EMPTY_TARIFF_OBSERVED', reason, tariffCount: rows.length,
        httpStatus: 503, outcome: 'refused', ...binding });
    }
`;
export function applyPreview363Body(source, artifact, reverse = false) {
  if (typeof source !== 'string' || typeof artifact?.prefix !== 'string'
    || !artifact.prefix.startsWith('// Scoped PR363 empty-tariff observer.\n')
    || artifact.hook !== PREVIEW363_HOOK) throw Error('PREVIEW363_PATCH_ARTIFACT');
  if (reverse) {
    if (!source.startsWith(artifact.prefix)
      || source.slice(artifact.prefix.length).split(PREVIEW363_ANCHOR + PREVIEW363_HOOK).length !== 2) throw Error('PREVIEW363_INVERSE_DRIFT');
    return source.slice(artifact.prefix.length).replace(PREVIEW363_ANCHOR + PREVIEW363_HOOK, PREVIEW363_ANCHOR);
  }
  if (source.includes('PREVIEW_EMPTY_TARIFF_OBSERVED') || source.split(PREVIEW363_ANCHOR).length !== 2) throw Error('PREVIEW363_ANCHOR_DRIFT');
  return artifact.prefix + source.replace(PREVIEW363_ANCHOR, PREVIEW363_ANCHOR + PREVIEW363_HOOK);
}

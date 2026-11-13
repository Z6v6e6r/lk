// Only inspect the already-read reply. No rows, identifiers, dates, URL values or
// provider text leave this function; missing evidence stays absent/UNKNOWN.
export function previewEmptyTariffFacts(msg, stage, fields) {
  const facts = {};
  try {
    if (stage !== 'preview_router' || fields?.code !== 'PREVIEW_EMPTY_TARIFF_OBSERVED'
      || fields.reason !== 'empty_tariff_list' || msg?._subscriptionPricePreview?.step !== 'groupTariff') return {};
    const own = (object, key) => object && typeof object === 'object'
      ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    const ctx = own(msg, '_subscriptionPricePreview');
    const payload = own(msg, 'payload');
    const kind = value => value === undefined ? 'missing' : value === null ? 'null'
      : Array.isArray(value) ? 'array' : typeof value === 'string' ? 'text'
        : ['object', 'number', 'boolean'].includes(typeof value) ? typeof value : 'UNKNOWN';
    facts.responseKind = kind(payload);
    const status = own(msg, 'statusCode');
    if (Number.isInteger(status) && status >= 100 && status <= 599) facts.upstreamStatus = status;
    // These two facts are established by the preceding business guards. Do not
    // rerun/replace the canonical parser or turn an unknown count into zero.
    facts.tariffCompleteListGuardPassed = true;
    facts.tariffExtractedEmpty = true;
    facts.tariffTransportErrorPresent = Boolean(own(msg, 'error'));

    const tenant = own(ctx, 'tenantKey'), exercise = own(ctx, 'exerciseId');
    facts.tariffBindingContextPresent = typeof tenant === 'string' && tenant.length > 0
      && typeof exercise === 'string' && exercise.length > 0;
    facts.tariffMethodMatch = own(msg, 'method') === 'GET';
    const responseUrl = own(msg, 'responseUrl');
    facts.tariffResponseUrlPresent = responseUrl !== undefined;
    if (facts.tariffBindingContextPresent) {
      const expected = `https://api.vivacrm.ru/end-user/api/v2/${tenant}/products/one-times?exerciseId=${encodeURIComponent(exercise)}`;
      const requestUrl = own(msg, 'url');
      facts.tariffRequestScopeMatch = requestUrl === expected;
      if (responseUrl !== undefined) facts.tariffResponseScopeMatch = responseUrl === expected;
      // Distinguish the tenant/event components, but never emit the URL or parts.
      if (typeof requestUrl === 'string') {
        try {
          const parsed = new URL(requestUrl);
          facts.tariffTenantScopeMatch = parsed.origin === 'https://api.vivacrm.ru'
            && parsed.pathname === `/end-user/api/v2/${tenant}/products/one-times`;
          const ids = parsed.searchParams.getAll('exerciseId');
          facts.tariffExerciseScopeMatch = ids.length === 1 && ids[0] === exercise;
        } catch { /* An unparsable scope supplies no component evidence. */ }
      }
    }

    // Fixed envelope names only. Never enumerate arbitrary provider field names,
    // access getters, walk array elements, or retain the payload after observing.
    const recognized = ['content', 'items', 'records', 'bookings', 'data', 'payload', 'result'];
    const alternate = ['products', 'tariffs', 'rows'];
    const pending = [{ value: payload, depth: 0 }], seen = new Set();
    let visited = 0, recognizedArrays = 0, direct = false, nested = false;
    let nonempty = false, other = false, otherNonempty = false, truncated = false;
    while (pending.length) {
      if (visited >= 64) { truncated = true; break; }
      const { value, depth } = pending.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value); visited++;
      if (Array.isArray(value)) { recognizedArrays++; nonempty ||= value.length > 0; continue; }
      for (const key of recognized) {
        const child = own(value, key);
        if (Array.isArray(child)) {
          recognizedArrays++; nonempty ||= child.length > 0;
          if (depth === 0) direct = true; else nested = true;
        } else if (child && typeof child === 'object') {
          if (depth >= 6) truncated = true;
          else pending.push({ value: child, depth: depth + 1 });
        }
      }
      for (const key of alternate) {
        const child = own(value, key);
        if (Array.isArray(child)) { other = true; otherNonempty ||= child.length > 0; }
      }
    }
    facts.tariffListShape = Array.isArray(payload) ? 'ROOT_ARRAY' : direct ? 'DIRECT_ARRAY'
      : nested ? 'NESTED_ARRAY' : truncated ? 'UNKNOWN' : 'NO_RECOGNIZED_ARRAY';
    facts.tariffRecognizedArrayCount = Math.min(recognizedArrays, 1000);
    facts.tariffShapeScanTruncated = truncated;
    // A positive witness remains useful in a truncated scan. Absence does not.
    if (nonempty || !truncated) facts.tariffShadowedNonemptyArray = nonempty;
    if (other || !truncated) facts.tariffAlternateArrayPresent = other;
    if (otherNonempty || !truncated) facts.tariffAlternateNonemptyArray = otherNonempty;
    facts.tariffShapeScanFailed = false;
  } catch {
    // Do not expose partial negative observations as proof of absence.
    delete facts.tariffShadowedNonemptyArray;
    delete facts.tariffAlternateArrayPresent;
    delete facts.tariffAlternateNonemptyArray;
    facts.tariffShapeScanFailed = true;
  }
  return facts;
}

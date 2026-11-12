// Diagnostic claims only: never authorization, record identity or idempotency.
const buildPattern = /^[0-9a-f]{40}$/;
const operationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function gamePatchRoute(path) {
  if (typeof path !== 'string' || path.length > 2048) return null;
  if (/^\/lk\/games\/records\/[^/?#]+$/.test(path)) return '/lk/games/records/:gameId';
  if (/^\/lk\/games\/[^/?#]+$/.test(path)) return '/lk/games/:gameId';
  return null;
}
export function gamePatchClaims(params) {
  try {
    const build = params.getAll('__lk_diag_build');
    const operation = params.getAll('__lk_diag_op');
    const claimedBuild = build.length === 1 ? build[0] : undefined;
    const claimedOperation = operation.length === 1 ? operation[0] : undefined;
    return {
      callerBuild: typeof claimedBuild === 'string' && buildPattern.test(claimedBuild) ? claimedBuild : 'UNKNOWN',
      ...(typeof claimedOperation === 'string' && operationPattern.test(claimedOperation)
        ? { logicalOperation: claimedOperation.toLowerCase() } : {}),
    };
  } catch { return { callerBuild: 'UNKNOWN' }; }
}
export function gamePatchDiagnosticUrl(url, claims) {
  try {
    if (typeof url !== 'string' || !url.startsWith('/lk/games/') || url.includes('#')) return url;
    const parsed = new URL(url, 'https://diagnostic.invalid');
    if (!gamePatchRoute(parsed.pathname)) return url;
    // Delete even malformed pre-existing diagnostic values; no arbitrary text survives.
    parsed.searchParams.delete('__lk_diag_build'); parsed.searchParams.delete('__lk_diag_op');
    const claimedBuild = claims?.callerBuild, claimedOperation = claims?.logicalOperation;
    if (typeof claimedBuild === 'string' && buildPattern.test(claimedBuild)) parsed.searchParams.set('__lk_diag_build', claimedBuild);
    if (typeof claimedOperation === 'string' && operationPattern.test(claimedOperation)) parsed.searchParams.set('__lk_diag_op', claimedOperation.toLowerCase());
    return parsed.pathname + parsed.search;
  } catch { return url; }
}

// Source-only log format for the existing pgm_v02 maps. It neither attaches an access_log
// nor changes any admission/rate-limit/routing policy. Separate approved rollout required.
export function buildMembershipDiagnosticLogFormat() {
  return `log_format pgm_diagnostics_v1 escape=json '{"schemaVersion":1,"diagnosticEventId":"$request_id","requestId":"$request_id","eventKind":"audit","source":"nginx","stage":"membership_admission","code":"UNKNOWN","serverEpoch":"$msec","admitted":"$pgm_v02_admitted","clientVerified":"$pgm_v02_verified","routeValid":"$pgm_v02_route","framingInvalid":"$pgm_v02_bad_framing","clientBound":"$pgm_v02_client_bound","httpStatus":"$status"}';\n`;
}
export function parseMembershipDiagnostic(row, sanitizeEvent) {
  if (!row || typeof row !== 'object') return null;
  const seconds = typeof row.serverEpoch === 'string' && /^\d{10}\.\d{3}$/.test(row.serverEpoch) ? Number(row.serverEpoch) : NaN;
  if (!Number.isFinite(seconds)) return null;
  const flag = value => value === '1' ? true : value === '0' ? false : undefined;
  return sanitizeEvent({ schemaVersion: 1, diagnosticEventId: row.diagnosticEventId, requestId: row.requestId,
    eventKind: 'audit', source: 'nginx', stage: 'membership_admission', code: 'UNKNOWN', serverTimeUtc: new Date(seconds * 1000).toISOString(),
    admitted: flag(row.admitted), clientVerified: flag(row.clientVerified), routeValid: flag(row.routeValid),
    framingValid: row.framingInvalid === '0' ? true : row.framingInvalid === '1' ? false : undefined,
    clientBound: flag(row.clientBound), httpStatus: /^\d{3}$/.test(row.httpStatus) ? Number(row.httpStatus) : undefined });
}

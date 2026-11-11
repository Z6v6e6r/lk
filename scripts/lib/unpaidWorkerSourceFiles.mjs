// Exact installed worker cohort. Kept separate from executable CLI verifiers so
// the read-only inspector can be bundled and streamed over stdin without a CLI.
export const UNPAID_SOURCE_FILES = Object.freeze({
  'launch_lk1_unpaid_booking_cancellation.mjs': 'scripts/launch_lk1_unpaid_booking_cancellation.mjs',
  'run_lk1_unpaid_booking_cancellation.mjs': 'scripts/run_lk1_unpaid_booking_cancellation.mjs',
  'lib/lk1UnpaidBookingCancellation.mjs': 'scripts/lib/lk1UnpaidBookingCancellation.mjs',
  'lib/lk1VivaServiceToken.mjs': 'scripts/lib/lk1VivaServiceToken.mjs',
  'lib/lk1LiveGatewayGuard.mjs': 'scripts/lib/lk1LiveGatewayGuard.mjs',
  'lib/lk1FlowReadTokenAuth.cjs': 'scripts/lib/lk1FlowReadTokenAuth.cjs',
  'lib/lk1UnpaidScanCursor.mjs': 'scripts/lib/lk1UnpaidScanCursor.mjs',
  'package.json': 'scripts/lk1_unpaid_cancel_service/package.json',
  'package-lock.json': 'scripts/lk1_unpaid_cancel_service/package-lock.json',
  'lk1-unpaid-cancel.service': 'scripts/lk1_unpaid_cancel_service/lk1-unpaid-cancel.service',
  'verify_bundle.mjs': 'scripts/lk1_unpaid_cancel_service/verify_bundle.mjs',
});

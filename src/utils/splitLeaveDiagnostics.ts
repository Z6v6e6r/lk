import { trackAnalyticsEvent } from './analytics';
import { clientDiagnostic, routeTemplate } from './errorDiagnostics';
import { createLeaveRecorder, leaveActions } from './splitLeaveTrace.mjs';

// Shared by independently loaded main/games IIFEs; one recorder and listener set per document.
const recorderKey = Symbol.for('padlhub.splitLeaveDiagnostics.v1');
type Recorder = ReturnType<typeof createLeaveRecorder>;
type DiagnosticDocument = Document & { [recorderKey]?: Recorder };
function recorder(): Recorder | undefined {
  if (typeof document === 'undefined') return undefined;
  return (document as DiagnosticDocument)[recorderKey];
}

export function installSplitLeaveDiagnostics(): void {
  try {
    if (typeof document === 'undefined' || recorder()) return;
    const state = createLeaveRecorder();
    const capture = (event: Event) => {
      try {
        const target = event.target instanceof Element ? event.target : null;
        const control = target?.closest('button, a, [role="button"]');
        if (!control || !control.closest('#root, #lk-overlay, .lk-overlay, .app-container, [data-lk-leave-action]')) return;
        if (event.type === 'keydown') {
          const key = (event as KeyboardEvent).key;
          if (key !== 'Enter' && key !== ' ') return;
        }
        const marker = control.getAttribute('data-lk-leave-action');
        const action = marker && leaveActions.includes(marker) && !marker.startsWith('CONFIRM_')
          ? marker : 'OTHER_CONTROL';
        state.record(action, event.type === 'keydown' ? 'key_activate' : event.type, event.isTrusted);
      } catch { /* Observing a control cannot affect its action. */ }
    };
    for (const kind of ['pointerdown', 'click', 'keydown']) document.addEventListener(kind, capture, { capture: true, passive: true });
    (document as DiagnosticDocument)[recorderKey] = state;
  } catch { /* Diagnostics are optional, including on restricted embedded documents. */ }
}

export function recordSplitLeaveConfirmation(accepted: boolean): void {
  try { recorder()?.record(accepted ? 'CONFIRM_ACCEPT' : 'CONFIRM_DISMISS', 'confirm'); } catch { /* best effort */ }
}

export function captureSplitLeaveInitiator(url: string, method: string, logicalOperation?: string): void {
  try {
    if (method.toUpperCase() !== 'POST' || routeTemplate(url) !== '/lk/games/:gameId/split/leave') return;
    // Capture synchronously, before request() reaches an await. Never inspect request options/body/auth.
    const leaveTrace = recorder()?.capture(new Error().stack, document.visibilityState);
    if (!leaveTrace) return;
    const event = clientDiagnostic({ routeTemplate: '/lk/games/:gameId/split/leave', method: 'POST',
      stage: 'leave_initiator', code: 'SPLIT_LEAVE_INITIATED', logicalOperation, leaveTrace });
    if (event) trackAnalyticsEvent('client_error', event);
  } catch { /* No await, request replay or change to the leave result on a diagnostic failure. */ }
}

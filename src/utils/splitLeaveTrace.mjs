// Only closed technical values leave this module. Never retain a raw stack or DOM event.
import { leaveAssets, leaveActions, leaveKinds, sanitizeLeaveTrace } from './errorDiagnosticsCore.mjs';
export { leaveAssets, leaveActions, leaveKinds, sanitizeLeaveTrace };
const validInteger = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

export function leaveStackFrames(stack) {
  if (typeof stack !== 'string') return [];
  return stack.slice(0, 8192).split('\n').slice(1, 33).flatMap(frame => {
    // V8 and Safari/WebKit: discard function names, origin, path, query and fragment.
    const match = frame.match(/(https?:\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/);
    if (!match) return [];
    try {
      const path = new URL(match[1]).pathname;
      const asset = leaveAssets.find(name => path.endsWith(`/${name}`));
      return asset ? [{ asset, line: Number(match[2]), column: Number(match[3]) }] : [];
    } catch { return []; }
  }).filter(frame => validInteger(frame.line, 10000000) && validInteger(frame.column, 10000000)).slice(0, 8);
}

export function createLeaveRecorder(now = () => performance.now()) {
  let actions = [], sent = [];
  return {
    record(action, kind, trusted) {
      if (!leaveActions.includes(action) || !leaveKinds.includes(kind)) return;
      const at = now();
      actions = actions.filter(item => at >= item.at && at - item.at <= 120000).slice(-7);
      actions.push({ action, kind, ...(typeof trusted === 'boolean' ? { trusted } : {}), at });
    },
    capture(stack, visibility) {
      const at = now();
      sent = sent.filter(time => at >= time && at - time < 60000);
      if (sent.length >= 6) return null;
      sent.push(at);
      return sanitizeLeaveTrace({ frames: leaveStackFrames(stack), visibility,
        actions: actions.filter(item => at >= item.at && at - item.at <= 120000)
          .map(item => ({ ...item, ageMs: Math.floor(at - item.at) })) });
    },
  };
}

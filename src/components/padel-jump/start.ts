import type { TiltStatus } from './tilt';

type StartEnvironment = {
  autoTilt: () => boolean;
  enableTilt: () => void;
  recalibrate: () => void;
  begin: () => void;
  canBegin: () => boolean;
  pending: (value: boolean) => void;
};

/** One start gesture requests permission; the round waits for calibration or manual fallback. */
export function createJumpStarter(env: StartEnvironment) {
  let status: TiltStatus = 'off';
  let pending = false;
  let auto = true;
  let attempted = false;
  const finish = () => {
    pending = false;
    env.pending(false);
    if (env.canBegin()) env.begin();
  };
  return {
    play() {
      if (pending) return;
      pending = true;
      env.pending(true);
      if (status === 'requesting' || status === 'calibrating') return;
      if (status === 'active') { env.recalibrate(); return; }
      if (status === 'off' && auto && !attempted && env.autoTilt()) {
        attempted = true;
        // Keep this synchronous within the click stack for Safari requestPermission.
        env.enableTilt();
      } else finish();
    },
    status(next: TiltStatus) {
      status = next;
      if (next === 'requesting') attempted = true;
      if (pending && next !== 'requesting' && next !== 'calibrating') finish();
    },
    touch() { auto = false; },
    cancel() {
      if (!pending) return;
      pending = false;
      env.pending(false);
    },
  };
}

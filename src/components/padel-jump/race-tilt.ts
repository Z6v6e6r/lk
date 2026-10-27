import type { createTiltController, TiltStatus } from './tilt';

/** Permission stays inside the tap stack. A denied sensor must never block manual resume. */
export function readyRaceTilt(tilt: ReturnType<typeof createTiltController>, enable: boolean): Promise<void> {
  return new Promise(resolve => {
    let armed = false, initial: TiltStatus = 'off', unsubscribe = () => {};
    const timer = setTimeout(() => { tilt.disable(); finish(); }, 6000);
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    unsubscribe = tilt.subscribe(status => {
      if (!armed) { initial = status; return; }
      if (!['requesting', 'calibrating'].includes(status)) finish();
    });
    armed = true;
    if (enable) void tilt.enable();
    else if (['active', 'requesting', 'calibrating'].includes(initial)) tilt.recalibrate();
    else finish();
  });
}

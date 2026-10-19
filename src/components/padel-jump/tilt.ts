/** Optional, ephemeral sensor input. No samples are stored or sent anywhere. */
export type TiltStatus = 'off' | 'requesting' | 'calibrating' | 'active' | 'denied' | 'unavailable' | 'insecure';
export const TILT_STALE_MS = 750;
const SIGNAL_TIMEOUT_MS = 4000;
const DEAD_ZONE = 3;
const FULL_TILT = 20;

type Sample = { beta: number | null; gamma: number | null };
type SensorApi = { requestPermission?: () => Promise<string> };
export type TiltEnvironment = {
  secure: boolean;
  api?: SensorApi;
  angle: () => number;
  now: () => number;
  listen: (sample: (event: Sample) => void, rotate: () => void) => () => void;
  timer: (callback: () => void, ms: number) => () => void;
};

export function screenTilt({ beta, gamma }: Sample, angle: number): number | null {
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const turn = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  if (turn === 90) return beta;
  if (turn === 180) return -gamma;
  if (turn === 270) return -beta;
  return gamma;
}

export function tiltDirection(value: number, neutral: number): number {
  // beta may cross +/-180 degrees when the screen is in landscape.
  const delta = ((value - neutral + 540) % 360 + 360) % 360 - 180;
  const magnitude = Math.max(0, Math.min(1, (Math.abs(delta) - DEAD_ZONE) / (FULL_TILT - DEAD_ZONE)));
  return Math.sign(delta) * magnitude;
}

export function browserTiltEnvironment(): TiltEnvironment {
  const api = (window as Window & { DeviceOrientationEvent?: SensorApi }).DeviceOrientationEvent;
  return {
    secure: window.isSecureContext,
    api,
    angle: () => window.screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0,
    now: () => performance.now(),
    listen: (sample, rotate) => {
      window.addEventListener('deviceorientation', sample);
      window.addEventListener('orientationchange', rotate);
      window.screen.orientation?.addEventListener('change', rotate);
      return () => {
        window.removeEventListener('deviceorientation', sample);
        window.removeEventListener('orientationchange', rotate);
        window.screen.orientation?.removeEventListener('change', rotate);
      };
    },
    timer: (callback, ms) => {
      const id = window.setTimeout(callback, ms);
      return () => window.clearTimeout(id);
    },
  };
}

export function createTiltController(env: TiltEnvironment) {
  let status: TiltStatus = 'off';
  let generation = 0;
  let neutral: number | null = null;
  let filtered = 0;
  let receivedAt: number | null = null;
  let detach: (() => void) | undefined;
  let cancelTimeout: (() => void) | undefined;
  const subscribers = new Set<(status: TiltStatus) => void>();
  const publish = (next: TiltStatus) => {
    if (status === next) return;
    status = next;
    for (const subscriber of subscribers) subscriber(status);
  };
  const resetInput = () => { neutral = null; filtered = 0; receivedAt = null; };
  const stop = () => {
    generation++;
    detach?.(); detach = undefined;
    cancelTimeout?.(); cancelTimeout = undefined;
    resetInput();
  };
  const watchdog = () => {
    cancelTimeout?.();
    cancelTimeout = env.timer(() => { stop(); publish('unavailable'); }, SIGNAL_TIMEOUT_MS);
  };
  const recalibrate = () => {
    resetInput();
    if (detach) { publish('calibrating'); watchdog(); }
  };
  const onSample = (event: Sample) => {
    const value = screenTilt(event, env.angle());
    if (value === null) return;
    const now = env.now();
    if (neutral === null) neutral = value;
    const target = tiltDirection(value, neutral);
    const elapsed = receivedAt === null ? 0 : Math.max(0, (now - receivedAt) / 1000);
    filtered += (target - filtered) * (1 - Math.exp(-elapsed / 0.08));
    receivedAt = now;
    watchdog();
    publish('active');
  };

  return {
    subscribe(subscriber: (status: TiltStatus) => void) {
      subscribers.add(subscriber); subscriber(status);
      return () => { subscribers.delete(subscriber); };
    },
    async enable() {
      stop();
      if (!env.secure) { publish('insecure'); return; }
      if (!env.api) { publish('unavailable'); return; }
      const request = generation;
      publish('requesting');
      try {
        // Called synchronously from a click, before awaiting, as required by iOS.
        const permission = env.api.requestPermission ? await env.api.requestPermission() : 'granted';
        if (request !== generation) return;
        if (permission !== 'granted') { publish('denied'); return; }
        detach = env.listen(onSample, recalibrate);
        publish('calibrating');
        watchdog();
      } catch {
        if (request === generation) { stop(); publish('denied'); }
      }
    },
    disable() { stop(); publish('off'); },
    recalibrate,
    direction() {
      return status === 'active' && receivedAt !== null && env.now() - receivedAt <= TILT_STALE_MS ? filtered : 0;
    },
    dispose() { stop(); subscribers.clear(); status = 'off'; },
  };
}

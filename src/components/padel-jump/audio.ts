import type { GameEvent } from './engine.ts';

/** Quiet opt-in synthesized cues; no audio files, network or autoplay permission prompts. */
export function createJumpAudio(factory: () => AudioContext | undefined = () => typeof AudioContext === 'undefined' ? undefined : new AudioContext()) {
  let context: AudioContext | undefined, master: GainNode | undefined, enabled = false;
  const voices = new Set<OscillatorNode>();
  const stop = () => { for (const voice of voices) { try { voice.stop(); } catch { /* Already finished. */ } } voices.clear(); };
  const unlock = () => {
    if (!enabled) return;
    try {
      context ??= factory();
      if (!context) return;
      if (!master) { master = context.createGain(); master.gain.value = 0.035; master.connect(context.destination); }
      void context.resume().catch(() => {});
    } catch { /* Unsupported audio never blocks play. */ }
  };
  return {
    setEnabled(value: boolean) { enabled = value; if (!value) { stop(); if (context) void context.suspend().catch(() => {}); } },
    unlock,
    pause() { stop(); if (context) void context.suspend().catch(() => {}); },
    cue(event: GameEvent) {
      if (!enabled || !context || !master || context.state !== 'running' || voices.size >= 4) return;
      const frequency = event.type === 'star' ? 880 : event.type === 'finish' ? 660 : event.type === 'failure' ? 155 : event.type === 'glass' ? 1040 : event.type === 'landing' ? 300 : 0;
      if (!frequency) return;
      try {
        const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime;
        const duration = event.type === 'landing' ? 0.055 : 0.16;
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency + (Number(event.id) % 3 || 0) * 12, now);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * (event.type === 'failure' ? 0.6 : 1.3), now + duration);
        gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.5, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        oscillator.connect(gain); gain.connect(master); voices.add(oscillator);
        oscillator.onended = () => { voices.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(now); oscillator.stop(now + duration + 0.01);
      } catch { /* A suspended or interrupted audio device is optional. */ }
    },
    dispose() { stop(); const old = context; context = undefined; master = undefined; if (old) void old.close().catch(() => {}); },
  };
}

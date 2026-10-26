import type { InputBlock, LiveCommand, LivePlayer, LiveResult } from './live-contract';

export type LiveAck = { seq: number; player: LivePlayer; result?: LiveResult };
export type LiveTicket = LiveAck & { id: string; token: string; engine: string; rule: string };
type RaceRequest = (path: string, body: unknown, signal: AbortSignal, token?: string) => Promise<LiveAck>;

/** One in-flight request, ordered bounded input batches; capability remains in memory. */
export function createRaceTransport(ticket: LiveTicket, ack: (v: LiveAck) => void, error: (message: string, retryFinish?: boolean) => void, request: RaceRequest) {
  let sequence = 0, active = true, busy = false, blocks: InputBlock[] = [], count = 0, finalizing = false, finishInFlight = false;
  let playable = ticket.player.state === 'playing' && ticket.player.game.mode === 'running', controls = 0;
  let retryFinish: { seq: number; command: LiveCommand; inputs?: InputBlock[] } | undefined;
  let queue = Promise.resolve(), controller: AbortController | undefined;
  const send = (command: LiveCommand, inputs?: InputBlock[], beforeFinish = false) => {
    let envelope: { seq: number; command: LiveCommand; inputs?: InputBlock[] } | undefined;
    queue = queue.then(async () => {
      if (!active) throw new Error('CONNECTION_CLOSED');
      if (finalizing && command !== 'finish' && !beforeFinish) return;
      const body = command === 'finish' && retryFinish ? retryFinish : { seq: ++sequence, command, ...(inputs ? { inputs } : {}) }; envelope = body;
      let result: LiveAck | undefined;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        controller = new AbortController(); const timer = setTimeout(() => controller?.abort(), 8000);
        try { result = await request('runs/' + ticket.id, body, controller.signal, ticket.token); }
        catch (e) { if (!active || attempt || e instanceof Error && !['AbortError', 'TypeError'].includes(e.name)) throw e; }
        finally { clearTimeout(timer); }
      }
      if (active && result) {
        playable = result.player.state === 'playing' && result.player.game.mode === 'running';
        // These are only unsent predictions. The acknowledged envelope and its
        // sequence remain immutable; the server alone decides the checkpoint.
        if (!playable) { blocks = []; count = 0; }
        if (command === 'finish') retryFinish = undefined; ack(result);
      }
    }).catch((e: unknown) => { if (active) {
      const retry = command === 'finish' && envelope && (e instanceof TypeError || e instanceof Error && (e.name === 'AbortError' || 'status' in e && e.status === 503));
      if (retry) retryFinish = envelope; else active = false;
      error(e instanceof Error ? e.message : 'Связь с сервером прервана.', !!retry);
    } });
    return queue;
  };
  return {
    record(direction: number) { if (!active || finalizing || !playable || controls) return; const value = Math.round(direction * 100), last = blocks.at(-1); if (last?.[0] === value && last[1] < 120) last[1]++; else blocks.push([value, 1]); count++; },
    canStep: () => active && !finalizing && playable && !controls && count < 240 && blocks.length < 120,
    flush() {
      if (busy || !active || finalizing || controls) return queue;
      const inputs = blocks; blocks = []; count = 0; busy = true;
      return send('inputs', inputs, true).finally(() => { busy = false; });
    },
    async command(command: Exclude<LiveCommand, 'inputs'>) {
      if (!active || finalizing && command !== 'finish' || command === 'finish' && finishInFlight) return queue;
      controls++;
      // Lock admission synchronously, before awaiting already queued work. Only the
      // final buffered inputs and the identical finish envelope may follow this point.
      if (command === 'finish') { finalizing = true; finishInFlight = true; }
      try {
        await queue;
        if (blocks.length) { const inputs = blocks; blocks = []; count = 0; await send('inputs', inputs, command === 'finish'); }
        await send(command);
      } finally { controls--; if (command === 'finish') finishInFlight = false; }
    },
    dispose() { active = false; controller?.abort(); blocks = []; },
  };
}

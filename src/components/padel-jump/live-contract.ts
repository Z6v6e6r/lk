import type { Game } from './engine';

/** Separate from the existing endless EVENT protocol. Pin the full campaign replay closure. */
export const LIVE_ENGINE_VERSION = 'c23b203f001efe95ad4d8a6d30db7a5dd3cce0f1119478874be2272c2555e7ce';
export const LIVE_API = '/jump-live-api/';
export const LIVE_LIMIT = 12;
export const LIVE_RULE = 'five-lives-community-v2';
export const LIVE_LIVES = 5;
export const LIVE_SYNC = 'full-game-v1';
export type LiveCommand = 'inputs' | 'pause' | 'resume' | 'retry' | 'advance' | 'finish';
export type InputBlock = [number, number];
export type LivePlayer = { id: string; alias: string; slot: number; state: 'playing' | 'paused' | 'retry' | 'checkpoint' | 'finished' | 'eliminated';
  elapsedMs: number; playMs: number; failures: number; livesRemaining: number; completedParts: number; game: Game };
export type LiveResult = { id: string; alias: string; elapsedMs: number; playMs: number; failures: number; finishedAt: string; engine: string; rule: string };
export type LiveBoard = { engine: string; rule: string; players: LivePlayer[]; results: LiveResult[]; now: number };

export function formatRaceTime(milliseconds: number): string {
  const tenths = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 100);
  return `${Math.floor(tenths / 600).toString().padStart(2, '0')}:${Math.floor(tenths / 10 % 60).toString().padStart(2, '0')}.${tenths % 10}`;
}

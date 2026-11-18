export const leaveAssets: string[];
export const leaveActions: string[];
export const leaveKinds: string[];
export type LeaveTrace = { frames: { asset: string; line: number; column: number }[];
  actions: { action: string; kind: string; ageMs: number; trusted?: boolean }[]; visibility: string };
export function sanitizeLeaveTrace(input: unknown): LeaveTrace | undefined;
export function leaveStackFrames(stack: unknown): LeaveTrace['frames'];
export function createLeaveRecorder(now?: () => number): {
  record(action: string, kind: string, trusted?: boolean): void;
  capture(stack: unknown, visibility: unknown): LeaveTrace | null | undefined;
};

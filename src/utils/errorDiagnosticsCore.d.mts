export const SCHEMA_VERSION: number;
export const UUID: RegExp;
export const ROUTES: string[];
export function routeTemplate(path: unknown): string;
export function responseKind(value: unknown): string;
export function sanitizeEvent(input: unknown): Record<string, unknown> | null;

export const leaveAssets: string[];
export const leaveActions: string[];
export const leaveKinds: string[];
export function sanitizeLeaveTrace(input: unknown): import("./splitLeaveTrace.mjs").LeaveTrace | undefined;

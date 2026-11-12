export function gamePatchRoute(path: unknown): string | null;
export function gamePatchClaims(params: URLSearchParams): { callerBuild: string; logicalOperation?: string };
export function gamePatchDiagnosticUrl(url: string, claims: { callerBuild?: unknown; logicalOperation?: unknown }): string;

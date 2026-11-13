export function createDiagnosticBudget(limit?: number): { admit(now: number, kind: string): boolean; drain(): { kind: string; count: number }[] };

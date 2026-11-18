// Retired runtime interface. Kept fail-closed for old callers during cutover.
export function parseFprVivaStartLevel() { throw new Error('FPR_VIVA_LEVEL_RETIRED'); }
export function createFprVivaStartReader() { return async () => { throw new Error('FPR_VIVA_LEVEL_RETIRED'); }; }

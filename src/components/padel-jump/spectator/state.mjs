/** A structural patch against an immutable scene. Arrays keep their scene indices. */
export function sceneDelta(base, value) {
  if (Object.is(base, value)) return undefined;
  if (value === null || typeof value !== 'object' || base === null || typeof base !== 'object'
    || Array.isArray(base) !== Array.isArray(value) || Array.isArray(value) && base.length !== value.length) return value;
  const patch = {};
  for (const key of Object.keys(value)) {
    const delta = sceneDelta(base[key], value[key]);
    if (delta !== undefined) patch[key] = delta;
  }
  return Object.keys(patch).length ? patch : undefined;
}

export function applySceneDelta(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid scene key');
    result[key] = applySceneDelta(base?.[key], patch[key]);
  }
  return result;
}

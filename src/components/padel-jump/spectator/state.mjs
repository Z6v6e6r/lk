/** A structural patch against an immutable scene. Arrays keep their scene indices. */
export function sceneDelta(base, value) {
  if (Object.is(base, value)) return undefined;
  if (Array.isArray(base) && Array.isArray(value) && base.every(hasId) && value.every(hasId)) {
    const byId = new Map(base.map((item, index) => [item.id, index]));
    const indices = [], changes = {};
    let reordered = base.length !== value.length;
    value.forEach((item, index) => {
      const source = byId.get(item.id) ?? -1; indices.push(source);
      if (source !== index) reordered = true;
      const delta = sceneDelta(base[source], item);
      if (delta !== undefined) changes[index] = delta;
    });
    return reordered || Object.keys(changes).length ? { $indices: indices, $changes: changes } : undefined;
  }
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
  if (Array.isArray(patch.$indices)) {
    if (!Array.isArray(base) || patch.$indices.length > 512 || !patch.$changes || typeof patch.$changes !== 'object') throw new TypeError('Invalid scene array');
    return patch.$indices.map((source, index) => {
      if (!Number.isInteger(source) || source < -1 || source >= base.length) throw new TypeError('Invalid scene index');
      return Object.hasOwn(patch.$changes, index) ? applySceneDelta(base[source], patch.$changes[index]) : base[source];
    });
  }
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid scene key');
    result[key] = applySceneDelta(base?.[key], patch[key]);
  }
  return result;
}

function hasId(item) { return item !== null && typeof item === 'object' && (typeof item.id === 'string' || typeof item.id === 'number'); }

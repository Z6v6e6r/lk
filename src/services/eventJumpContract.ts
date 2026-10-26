// Bump with the exact shared campaign+engine bytes; checked by the flow builder.
export const EVENT_JUMP_ENGINE_VERSION = '5dcc590e4c5151ab1c9e156fec39aa3d5c8c38560b7cda52d6f62963108e88aa';

export function eventGameCommandBody(body: Record<string, unknown> = {}) {
  return {...body, engineVersion: EVENT_JUMP_ENGINE_VERSION};
}

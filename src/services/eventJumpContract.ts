// Pin every simulation dependency, not only campaign+engine. The EVENT protocol remains separate.
export const EVENT_JUMP_ENGINE_FILES = ['campaign.ts', 'level-layout.ts', 'engine.ts'] as const;
export const EVENT_JUMP_ENGINE_VERSION = 'c23b203f001efe95ad4d8a6d30db7a5dd3cce0f1119478874be2272c2555e7ce';

export function eventGameCommandBody(body: Record<string, unknown> = {}) {
  return {...body, engineVersion: EVENT_JUMP_ENGINE_VERSION};
}

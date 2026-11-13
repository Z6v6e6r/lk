import type { Plugin } from 'vite';

// Independently published exhibition module; unrelated cabinet releases retain it.
export const EXHIBITION_GAME_SOURCE = '8b45b15ef10268cc56e70a03836d7806dbb19e85';

export function exhibitionWidgetUrl(source = EXHIBITION_GAME_SOURCE): string {
  if (!/^[a-f0-9]{40}$/.test(source)) {
    throw new Error('Invalid PADLHUB_EXHIBITION_GAME_SOURCE: expected a full immutable commit SHA');
  }
  return `https://padlhub.su/lk/padel-jump-exhibition-${source.slice(0, 8)}/assets/cabinet.js`;
}

export function exhibitionModuleGuard(url: string, artifactName: string): Plugin {
  return {
    name: 'lk-exhibition-module-guard',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const artifact = bundle[artifactName];
      if (artifact?.type !== 'chunk' || !artifact.code.includes(url)) {
        throw new Error(`${artifactName} is missing the pinned exhibition game module: ${url}`);
      }
    },
  };
}

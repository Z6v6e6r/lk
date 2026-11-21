export type PreviewStage = 'current' | 'full';

export function readPreviewStage(params: URLSearchParams): PreviewStage {
  if (params.get('stage') === 'current') return 'current';
  // Old shared local scenarios with Boost keep their original meaning.
  return params.get('stage') === 'full' || params.get('boost') === '1' ? 'full' : 'current';
}

export type PreviewSkin = 'current' | 'lk2';

export function readPreviewSkin(params: URLSearchParams): PreviewSkin {
  return params.get('skin') === 'lk2' ? 'lk2' : 'current';
}

// Skin changes update CSS in place. All booking parameters still reload the
// fixture as before, but switching the skin must not reset a step or purchase.
export function previewFrameQuery(params: URLSearchParams): string {
  const frame = new URLSearchParams(params);
  frame.delete('skin');
  return frame.toString();
}

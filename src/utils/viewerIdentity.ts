export interface ViewerIdentity {
  id?: string | null;
  phone?: string | null;
  isViewer?: boolean;
}

function identityPhone(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

/** Presentation only: these markers must never authorize a server command. */
export function isViewerIdentity(identity: ViewerIdentity | null | undefined, viewer: ViewerIdentity): boolean {
  if (!identity) return false;
  if (identity.isViewer === true) return true;
  // Public responses can carry false without a viewer context; stable IDs still
  // identify the local user. This is display state, never an authorization check.
  const id = identity.id?.trim();
  const viewerId = viewer.id?.trim();
  if (id && viewerId && id === viewerId) return true;
  // Older responses still use a phone until frontend and backend rollouts converge.
  const phone = identityPhone(identity.phone);
  const viewerPhone = identityPhone(viewer.phone);
  return Boolean(phone && viewerPhone && phone === viewerPhone);
}

export function getIdentityKey(identity: ViewerIdentity | null | undefined): string | null {
  const id = identity?.id?.trim();
  if (id) return `id:${id}`;
  const phone = identityPhone(identity?.phone);
  return phone ? `phone:${phone}` : null;
}

export function getIdentityMessageKey(message: {
  id?: string | null;
  createdTs: number;
  text: string;
  sender?: ViewerIdentity | null;
}): string {
  const id = message.id?.trim();
  return id ? `message:${id}` : `${message.createdTs}|${getIdentityKey(message.sender) ?? "unknown"}|${message.text}`;
}

export interface OverlaySession {
  isCurrent: () => boolean;
  own: (cleanup: () => void) => void;
  clear: () => void;
  close: () => boolean;
}

type OwnedSession = OverlaySession & {
  cleanup?: () => void;
  retired: boolean;
};

export function createOverlayLifecycle(scheduleCleanup: (cleanup: () => void) => void) {
  let current: OwnedSession | null = null;
  const pending = new Set<OwnedSession>();

  function clear(session: OwnedSession) {
    const cleanup = session.cleanup;
    session.cleanup = undefined;
    cleanup?.();
  }

  function retire(session: OwnedSession) {
    if (session.retired) return;
    session.retired = true;
    clear(session);
  }

  function begin(): OverlaySession {
    const previous = current;
    const session: OwnedSession = {
      retired: false,
      isCurrent: () => current === session,
      own: (cleanup) => {
        if (current !== session) throw new Error("Overlay session is no longer current");
        session.cleanup = cleanup;
      },
      clear: () => { if (current === session) clear(session); },
      close: () => {
        if (current !== session) return false;
        current = null;
        pending.add(session);
        scheduleCleanup(() => {
          pending.delete(session);
          retire(session);
        });
        return true;
      },
    };
    // Detach the previous owner before cleanup, which may call its onClose again.
    current = session;
    if (previous) retire(previous);
    // Flush a closing root before a new owner can replace any of its DOM.
    for (const closing of pending) {
      pending.delete(closing);
      retire(closing);
    }
    return session;
  }

  return { begin, close: () => current?.close() ?? false };
}

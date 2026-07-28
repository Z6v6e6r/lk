import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

type StickyPosition = "top" | "bottom" | null;

interface UseStickyCurrentUserRowParams {
  containerRef: RefObject<HTMLElement | null>;
  topOffset: number;
  bottomOffset: number;
  enabled: boolean;
}

interface StickyState {
  currentUserRowRef: (node: HTMLElement | null) => void;
  stickyPosition: StickyPosition;
  isStickyVisible: boolean;
  scrollToCurrentUser: () => void;
}

function resolveStickyPosition(rect: DOMRect, topOffset: number, bottomOffset: number): StickyPosition {
  const topBoundary = Math.max(0, topOffset);
  const bottomBoundary = window.innerHeight - Math.max(0, bottomOffset);

  if (rect.top < topBoundary) return "top";
  if (rect.bottom > bottomBoundary) return "bottom";
  return null;
}

function isScrollableElement(node: HTMLElement) {
  const overflowY = window.getComputedStyle(node).overflowY;
  if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
    return true;
  }
  if (overflowY === "hidden" || overflowY === "clip") {
    return false;
  }
  return node.scrollHeight > node.clientHeight + 1;
}

function collectScrollTargets(root: HTMLElement): EventTarget[] {
  const targets = new Set<EventTarget>([window]);
  const doc = root.ownerDocument;

  if (doc) {
    targets.add(doc);
    targets.add(doc.documentElement);
    targets.add(doc.body);
    if (doc.scrollingElement) {
      targets.add(doc.scrollingElement);
    }
  }

  let current: HTMLElement | null = root;
  while (current) {
    if (isScrollableElement(current)) {
      targets.add(current);
    }
    current = current.parentElement;
  }

  return Array.from(targets);
}

export function useStickyCurrentUserRow({
  containerRef,
  topOffset,
  bottomOffset,
  enabled,
}: UseStickyCurrentUserRowParams): StickyState {
  const [rowNode, setRowNode] = useState<HTMLElement | null>(null);
  const [stickyPosition, setStickyPosition] = useState<StickyPosition>(null);
  const stickyHideTimerRef = useRef<number | null>(null);

  const clearStickyHideTimer = useCallback(() => {
    if (stickyHideTimerRef.current == null) return;
    window.clearTimeout(stickyHideTimerRef.current);
    stickyHideTimerRef.current = null;
  }, []);

  const applyStickyPosition = useCallback((nextPosition: StickyPosition) => {
    if (nextPosition) {
      clearStickyHideTimer();
      setStickyPosition((prev) => (prev === nextPosition ? prev : nextPosition));
      return;
    }

    if (stickyHideTimerRef.current != null) {
      return;
    }

    stickyHideTimerRef.current = window.setTimeout(() => {
      stickyHideTimerRef.current = null;
      setStickyPosition((prev) => (prev == null ? prev : null));
    }, 120);
  }, [clearStickyHideTimer]);

  const currentUserRowRef = useCallback((node: HTMLElement | null) => {
    setRowNode(node);
  }, []);

  const scrollToCurrentUser = useCallback(() => {
    rowNode?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [rowNode]);

  useEffect(() => {
    if (!enabled || !rowNode) {
      clearStickyHideTimer();
      setStickyPosition(null);
      return;
    }

    const normalizedTopOffset = Math.max(0, Math.round(topOffset));
    const normalizedBottomOffset = Math.max(0, Math.round(bottomOffset));

    const observer = new IntersectionObserver(
      ([entry]) => {
        const nextPosition = resolveStickyPosition(entry.boundingClientRect, topOffset, bottomOffset);
        applyStickyPosition(nextPosition);
      },
      {
        root: null,
        threshold: [0, 0.01, 0.99, 1],
        rootMargin: `-${normalizedTopOffset}px 0px -${normalizedBottomOffset}px 0px`,
      },
    );

    observer.observe(rowNode);
    return () => {
      observer.disconnect();
      clearStickyHideTimer();
    };
  }, [applyStickyPosition, bottomOffset, clearStickyHideTimer, enabled, rowNode, topOffset]);

  useEffect(() => {
    if (!enabled || !rowNode) {
      clearStickyHideTimer();
      setStickyPosition(null);
      return;
    }

    const container = containerRef.current;
    if (!container) {
      clearStickyHideTimer();
      setStickyPosition(null);
      return;
    }

    let frameId: number | null = null;

    const updatePosition = () => {
      frameId = null;
      const rect = rowNode.getBoundingClientRect();
      const nextPosition = resolveStickyPosition(rect, topOffset, bottomOffset);
      applyStickyPosition(nextPosition);
    };

    const requestUpdatePosition = () => {
      if (frameId != null) return;
      frameId = window.requestAnimationFrame(updatePosition);
    };

    const scrollTargets = collectScrollTargets(container);
    requestUpdatePosition();
    scrollTargets.forEach((target) => {
      target.addEventListener("scroll", requestUpdatePosition, { passive: true });
    });
    window.addEventListener("resize", requestUpdatePosition);

    return () => {
      scrollTargets.forEach((target) => {
        target.removeEventListener("scroll", requestUpdatePosition);
      });
      window.removeEventListener("resize", requestUpdatePosition);
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
      clearStickyHideTimer();
    };
  }, [applyStickyPosition, bottomOffset, clearStickyHideTimer, containerRef, enabled, rowNode, topOffset]);

  const isStickyVisible = useMemo(
    () => enabled && stickyPosition !== null,
    [enabled, stickyPosition],
  );

  return {
    currentUserRowRef,
    stickyPosition,
    isStickyVisible,
    scrollToCurrentUser,
  };
}

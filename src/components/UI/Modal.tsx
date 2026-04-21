import { type CSSProperties, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useIsOverlayScope } from "../../context/OverlayScopeContext";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  hideHeader?: boolean;
  bodyClassName?: string;
  variant?: "sheet" | "dialog" | "fullscreen";
}

const MODAL_SCROLL_LOCK_CLASS = "modal-scroll-locked";
const OVERLAY_PORTAL_ID = "lk-overlay";

type ScrollLockSnapshot = {
  scrollY: number;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
  bodyOverflow: string;
  bodyPaddingRight: string;
  htmlOverflow: string;
};

let openModalCount = 0;
let scrollLockSnapshot: ScrollLockSnapshot | null = null;

function getViewportOffsetTop() {
  if (typeof window === "undefined") return 0;
  return Math.max(0, window.visualViewport?.offsetTop ?? 0);
}

function lockDocumentScroll() {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  openModalCount += 1;
  if (openModalCount > 1) return;

  const { body, documentElement } = document;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  const scrollbarCompensation = Math.max(0, window.innerWidth - documentElement.clientWidth);

  scrollLockSnapshot = {
    scrollY,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
    htmlOverflow: documentElement.style.overflow,
  };

  body.classList.add(MODAL_SCROLL_LOCK_CLASS);
  documentElement.classList.add(MODAL_SCROLL_LOCK_CLASS);
  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  if (scrollbarCompensation > 0) {
    body.style.paddingRight = `${scrollbarCompensation}px`;
  }
  documentElement.style.overflow = "hidden";
}

function unlockDocumentScroll() {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount > 0) return;

  const snapshot = scrollLockSnapshot;
  scrollLockSnapshot = null;

  const { body, documentElement } = document;
  body.classList.remove(MODAL_SCROLL_LOCK_CLASS);
  documentElement.classList.remove(MODAL_SCROLL_LOCK_CLASS);

  body.style.position = snapshot?.bodyPosition ?? "";
  body.style.top = snapshot?.bodyTop ?? "";
  body.style.left = snapshot?.bodyLeft ?? "";
  body.style.right = snapshot?.bodyRight ?? "";
  body.style.width = snapshot?.bodyWidth ?? "";
  body.style.overflow = snapshot?.bodyOverflow ?? "";
  body.style.paddingRight = snapshot?.bodyPaddingRight ?? "";
  documentElement.style.overflow = snapshot?.htmlOverflow ?? "";

  if (snapshot) {
    window.scrollTo(0, snapshot.scrollY);
  }
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  hideHeader = false,
  bodyClassName,
  variant = "sheet",
}: ModalProps) {
  const isOverlayScope = useIsOverlayScope();
  const [viewportOffsetTop, setViewportOffsetTop] = useState(0);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    lockDocumentScroll();
    return () => {
      unlockDocumentScroll();
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || typeof window === "undefined") {
      setViewportOffsetTop((current) => (current === 0 ? current : 0));
      return undefined;
    }

    const visualViewport = window.visualViewport;

    // Keep the dialog in its final position before the first paint to avoid a visible jump on open.
    const updateViewportOffset = () => {
      const nextOffsetTop = getViewportOffsetTop();
      setViewportOffsetTop((current) => (current === nextOffsetTop ? current : nextOffsetTop));
    };

    updateViewportOffset();

    visualViewport?.addEventListener("resize", updateViewportOffset);
    visualViewport?.addEventListener("scroll", updateViewportOffset);
    window.addEventListener("resize", updateViewportOffset);
    window.addEventListener("orientationchange", updateViewportOffset);

    return () => {
      visualViewport?.removeEventListener("resize", updateViewportOffset);
      visualViewport?.removeEventListener("scroll", updateViewportOffset);
      window.removeEventListener("resize", updateViewportOffset);
      window.removeEventListener("orientationchange", updateViewportOffset);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const overlayStyle = {
    "--modal-viewport-offset-top": `${viewportOffsetTop}px`,
  } as CSSProperties;

  const modalNode = (
    <div
      className={`modal-overlay modal-overlay--${variant}`}
      data-modal-scope={isOverlayScope ? "overlay" : "app"}
      style={overlayStyle}
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`modal-content modal-content--${variant}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {!hideHeader && (
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть окно">
              ✕
            </button>
          </div>
        )}
        <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return modalNode;
  }

  const portalTarget = isOverlayScope
    ? document.getElementById(OVERLAY_PORTAL_ID) ?? document.body
    : document.body;

  return createPortal(modalNode, portalTarget);
}

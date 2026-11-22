import { useEffect, useRef, type ReactNode } from 'react';

export function PurchaseOfferLayout({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = root.current?.closest('[role="dialog"]');
    // Keep the entire offer, including its footer, inside the visible preview.
    window.frameElement?.scrollIntoView({ block: 'start' });
    root.current?.querySelector<HTMLElement>('input:checked, [data-purchase-title]')?.focus();
    const trapFocus = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Tab') return;
      const targets = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:checked:not(:disabled), .matrix-purchase-scroll, details > summary');
      if (!targets?.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (!Array.from(targets).some(target => target === document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener('keydown', trapFocus);
    return () => {
      dialog?.removeEventListener('keydown', trapFocus);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <div className="matrix-purchase-offer" ref={root}>
    <div className="matrix-purchase-scroll" tabIndex={0} role="region" aria-label="Преимущества и стоимость записи">{children}</div>
    <footer className="matrix-purchase-footer">{footer}</footer>
  </div>;
}

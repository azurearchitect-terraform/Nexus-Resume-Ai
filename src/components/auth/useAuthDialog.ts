import { RefObject, useEffect, useRef } from 'react';

export function useAuthDialog(ref: RefObject<HTMLDivElement | null>, open: boolean, onClose?: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
    )).filter(node => node.getClientRects().length > 0);
    (focusable()[0] ?? element).focus();
    function handleKey(event: KeyboardEvent) {
      // A nested terms dialog owns focus and keyboard handling while open.
      if (!element?.contains(document.activeElement)) return;
      if ((event.target as HTMLElement).closest('[role="dialog"]') !== element) return;
      if (event.key === 'Escape' && close.current) {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref]);
}

import { useEffect, useRef } from 'react';

/** Restore the invoking control after DOM cleanup, including reduced motion. */
export function useDrawerFocus(open: boolean) {
  const target = useRef<HTMLElement | null>(null), wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open; wasOpen.current = open;
    if (!closed) return;
    const timer = setTimeout(() => { if (target.current?.isConnected) target.current.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [open]);
  return (element: HTMLElement) => { target.current = element; };
}

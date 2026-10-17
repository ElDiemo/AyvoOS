'use client';

import { useEffect, type RefObject } from 'react';

const CLOSED = 'ayvo:navigation-closed';

/** Called by the shell after its navigation drawer has closed (and restored its own focus). */
export function navigationClosed(): void {
  window.dispatchEvent(new Event(CLOSED));
}

/**
 * A scan page gives the focus back to its scan field after the navigation drawer was closed
 * (issue #11 UI-14): a keyboard-wedge scanner types into whatever has focus, and the drawer would
 * otherwise leave it on the menu button. Never takes the focus from another open dialog, and only
 * when the field exists and is enabled.
 */
export function useScanFocusReturn(field: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const restore = () => {
      const el = field.current;
      if (!el || el.disabled || !el.isConnected) return;
      if (document.querySelector('dialog[open]')) return;
      el.focus();
    };
    window.addEventListener(CLOSED, restore);
    return () => window.removeEventListener(CLOSED, restore);
  }, [field]);
}

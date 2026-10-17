'use client';

import { useEffect, useRef } from 'react';

/**
 * Brings the active item of a horizontally scrolled navigation into view on load, navigation and
 * width changes (issue #11 UI-08: on phones the selected tab was outside the visible strip). Scrolls only the
 * strip itself — never the page.
 */
export function ActiveIntoView({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const strip = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const center = () => {
      const active = el.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      const left = active.offsetLeft - el.offsetLeft;
      const target = left - (el.clientWidth - active.offsetWidth) / 2;
      el.scrollLeft = Math.max(0, target);
    };
    center();
    // Also when the width changes (rotation, a narrowed window — UI-08 follow-up).
    const observer = new ResizeObserver(center);
    observer.observe(el);
    return () => observer.disconnect();
  });
  return (
    <ul ref={strip} className={className} data-testid="module-tabs">
      {children}
    </ul>
  );
}

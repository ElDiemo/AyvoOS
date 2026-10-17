'use client';

import { useEffect, useRef } from 'react';

/**
 * Brings the active item of a horizontally scrolled navigation into view on load and navigation
 * (issue #11 UI-08: on phones the selected tab was outside the visible strip). Scrolls only the
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
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active) return;
    const left = active.offsetLeft - el.offsetLeft;
    const target = left - (el.clientWidth - active.offsetWidth) / 2;
    el.scrollLeft = Math.max(0, target);
  });
  return (
    <ul ref={strip} className={className} data-testid="module-tabs">
      {children}
    </ul>
  );
}

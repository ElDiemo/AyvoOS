/**
 * Leaving a form with unsaved changes (issue #11, UI-01). One guard at a time: the form that has
 * unsaved changes registers an asker; every way of leaving the page inside the application — an
 * internal link, switching the active site — asks it first. Reload, closing the tab and external
 * navigation are covered by the browser's own `beforeunload` prompt (UnsavedChangesGuard).
 */
type Asker = () => Promise<boolean>;

let asker: Asker | null = null;

/** Resolves true when leaving may proceed (nothing unsaved, or the user discarded the changes). */
export function confirmLeave(): Promise<boolean> {
  return asker ? asker() : Promise.resolve(true);
}

/** Registers the asker of the form with unsaved changes; returns the unregister function. */
export function registerLeaveGuard(a: Asker): () => void {
  asker = a;
  return () => {
    if (asker === a) asker = null;
  };
}

/**
 * The in-app destination of a click on a link, or null when the click must be left alone: not a
 * plain left click, a new tab/window, a download, another origin, or the same page (e.g. a hash).
 */
export function guardedLinkTarget(
  click: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  link: { href: string; target: string; download: boolean } | null,
  current: { origin: string; pathname: string; search: string },
): string | null {
  if (!link || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if ((link.target && link.target !== '_self') || link.download) return null;
  let url: URL;
  try {
    url = new URL(link.href, current.origin + current.pathname + current.search);
  } catch {
    return null;
  }
  if (url.origin !== current.origin) return null;
  if (url.pathname === current.pathname && url.search === current.search) return null;
  return url.pathname + url.search + url.hash;
}

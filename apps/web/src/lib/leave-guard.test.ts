import { afterEach, describe, expect, it } from 'vitest';
import { confirmLeave, guardedLinkTarget, registerLeaveGuard } from './leave-guard';

const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const here = { origin: 'https://app.test', pathname: '/admin/users/1', search: '' };
const link = (href: string, extra: Partial<{ target: string; download: boolean }> = {}) => ({
  href,
  target: '',
  download: false,
  ...extra,
});

describe('leaving a form with unsaved changes (UI-01)', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => unregister?.());

  it('guards only plain left clicks on in-app links to another page', () => {
    expect(guardedLinkTarget(click, link('/admin/users'), here)).toBe('/admin/users');
    expect(guardedLinkTarget(click, link('https://app.test/stock?x=1#a'), here)).toBe(
      '/stock?x=1#a',
    );
    expect(guardedLinkTarget(click, null, here)).toBeNull();
    expect(guardedLinkTarget({ ...click, button: 1 }, link('/admin/users'), here)).toBeNull();
    expect(guardedLinkTarget({ ...click, metaKey: true }, link('/admin/users'), here)).toBeNull();
    expect(guardedLinkTarget({ ...click, ctrlKey: true }, link('/admin/users'), here)).toBeNull();
    expect(guardedLinkTarget(click, link('/x', { target: '_blank' }), here)).toBeNull();
    expect(guardedLinkTarget(click, link('/file.pdf', { download: true }), here)).toBeNull();
    expect(guardedLinkTarget(click, link('https://other.test/x'), here)).toBeNull();
    expect(guardedLinkTarget(click, link('/admin/users/1#audit'), here)).toBeNull();
  });

  it('asks the registered form, and nobody once it unregisters', async () => {
    expect(await confirmLeave()).toBe(true);
    unregister = registerLeaveGuard(() => Promise.resolve(false));
    expect(await confirmLeave()).toBe(false);
    unregister();
    unregister = null;
    expect(await confirmLeave()).toBe(true);
  });
});

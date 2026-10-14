import type { PermissionCode } from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import type { Principal } from '../identity/principal.js';

/** The permission a station's mode needs (doc 025 §7, owner B4). */
export const MODE_PERMISSION: Record<'LABELING' | 'FILLING', PermissionCode> = {
  LABELING: 'production:label_apply',
  FILLING: 'production:fill',
};

/**
 * May the principal work at this station right now? Station routes are `@Authenticated()` and
 * call this on every request, because the needed permission depends on the stored station: the
 * mode's permission, the session's ACTIVE site = the station's site (never switched by a scan),
 * the site's PRODUCTION capability, access to the station's warehouse (doc 022) and an active
 * site for writes. A station QR never grants anything.
 */
export function assertMayWorkAt(
  principal: Principal,
  station: { mode: 'LABELING' | 'FILLING'; siteId: string; locationId: string },
  write: boolean,
): void {
  if (!principal.permissions.has(MODE_PERMISSION[station.mode])) {
    throw domainError(403, 'MODE_NOT_PERMITTED', 'You may not work in this station mode');
  }
  const site = principal.activeSite;
  if (!site) throw domainError(403, 'SITE_REQUIRED', 'Choose the site you are working at first');
  if (site.id !== station.siteId) {
    throw domainError(
      409,
      'STATION_OF_ANOTHER_SITE',
      'This station belongs to another site than the one you are working at',
    );
  }
  // The guard's capability check does not run on these @Authenticated routes: check it here.
  if (!site.capabilities.includes('PRODUCTION')) {
    throw domainError(409, 'SITE_WITHOUT_PRODUCTION', 'The active site does not produce');
  }
  if (!site.warehouseIds.has(station.locationId)) {
    throw domainError(403, 'FORBIDDEN', 'You have no access to the warehouse of this station');
  }
  if (write && !site.active) {
    throw domainError(
      409,
      'SITE_INACTIVE',
      'The site is inactive: its history can be read, not changed',
    );
  }
}

/** The refusal code of assertMayWorkAt, or null when the principal may work at the station. */
export function workRefusal(
  principal: Principal,
  station: { mode: 'LABELING' | 'FILLING'; siteId: string; locationId: string },
): string | null {
  try {
    assertMayWorkAt(principal, station, false);
    return null;
  } catch (error) {
    const body = (error as { getResponse?: () => unknown }).getResponse?.() as
      { code?: string } | undefined;
    return body?.code ?? 'FORBIDDEN';
  }
}

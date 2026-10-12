import 'server-only';
import { currentUserSchema, type CurrentUser, type PermissionCode } from '@ayvo/types';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { DEFAULT_TIME_ZONE } from '../i18n/cs/format';
import { apiGet, apiGetOptional } from './api';

/** The signed-in user as the API sees it right now (once per server render). */
export const currentUser = cache(async (): Promise<CurrentUser> =>
  apiGet('auth/me', currentUserSchema),
);

/** The signed-in user or null (sign-in and status pages). */
export const optionalUser = cache(async (): Promise<CurrentUser | null> =>
  apiGetOptional('auth/me', currentUserSchema),
);

/**
 * Page-level guard for nicer navigation. The API enforces every permission on its own — a page
 * check only avoids rendering a page whose data the user may not read.
 */
export async function requirePermission(permission: PermissionCode): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user.permissions.includes(permission)) redirect('/forbidden');
  return user;
}

/** Like requirePermission, for a section that any one of several permissions opens. */
export async function requireAnyPermission(
  permissions: readonly PermissionCode[],
): Promise<CurrentUser> {
  const user = await currentUser();
  if (!permissions.some((p) => user.permissions.includes(p))) redirect('/forbidden');
  return user;
}

export function hasPermission(user: CurrentUser, permission: PermissionCode): boolean {
  return user.permissions.includes(permission);
}

/** The IANA time zone of the session's active site, for showing that site's timestamps. */
export async function siteTimeZone(): Promise<string> {
  const user = await currentUser();
  return user.sites.find((s) => s.id === user.activeSiteId)?.timeZone ?? DEFAULT_TIME_ZONE;
}

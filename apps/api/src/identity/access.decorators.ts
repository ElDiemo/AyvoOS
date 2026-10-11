import type { PermissionCode } from '@ayvo/types';
import { SetMetadata } from '@nestjs/common';

export const ACCESS_METADATA = 'ayvo:access';

export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permissions: readonly PermissionCode[] };

/** Anonymous access (bottle passport, health, login). Use sparingly. */
export const Public = () => SetMetadata(ACCESS_METADATA, { kind: 'public' } satisfies AccessRule);

/** Any signed-in, active user (own profile, logout). */
export const Authenticated = () =>
  SetMetadata(ACCESS_METADATA, { kind: 'authenticated' } satisfies AccessRule);

/**
 * The signed-in user must hold ALL listed permissions (and the warehouse scope where the
 * permission is warehouse-scoped). Every protected route declares this explicitly.
 */
export const RequirePermission = (...permissions: [PermissionCode, ...PermissionCode[]]) =>
  SetMetadata(ACCESS_METADATA, { kind: 'permission', permissions } satisfies AccessRule);

import { API_BASE_PATH } from '@ayvo/types';

/**
 * Route families. Admin routes are for AYVO staff (on DEV: behind Basic Auth; the identity-access
 * module will add guards). Public routes serve anonymous users (bottle passport) and are the only
 * ones a future public QR host may expose.
 */
export const ADMIN_PREFIX = 'admin';
export const PUBLIC_PREFIX = 'public';

/** Absolute same-origin URL prefix of admin routes, for links in API responses. */
export const ADMIN_API = `${API_BASE_PATH}/${ADMIN_PREFIX}`;

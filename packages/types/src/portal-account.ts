import { z } from 'zod';
import { portalClientSchema } from './portal.js';

/**
 * "Zabezpečení účtu" in the hotel portal: replacing the authenticator app of the signed-in portal
 * account (the internal OS's `replace-mfa`, for the PORTAL audience). The current password and a
 * current code (or an unused recovery code) start it; the ordinary MFA step with a code of the NEW
 * app finishes it, which revokes every session of the account, issues a new one and new recovery
 * codes.
 */
export const portalReplaceMfaRequestSchema = z.strictObject({
  password: z
    .string()
    .min(1)
    .max(1024)
    .refine((v) => new TextEncoder().encode(v).length <= 1024),
  code: z.string().min(1).max(64),
  client: portalClientSchema,
});
export type PortalReplaceMfaRequest = z.infer<typeof portalReplaceMfaRequestSchema>;

const portalPassword = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => new TextEncoder().encode(v).length <= 1024);

/**
 * A signed-in portal account changes its password: the current password and a current code (or an
 * unused recovery code), then the new one (the activation/reset rule: at least 12 characters).
 * Every session of the account ends and the answer carries the one new session.
 */
export const portalChangePasswordRequestSchema = z.strictObject({
  currentPassword: portalPassword,
  newPassword: portalPassword.refine((v) => [...v].length >= 12),
  code: z.string().min(1).max(64),
  client: portalClientSchema,
});
export type PortalChangePasswordRequest = z.infer<typeof portalChangePasswordRequestSchema>;
export const portalChangePasswordResultSchema = z.object({
  session: z.string().min(1).max(128),
  maxAgeSeconds: z.number().int().positive(),
});
export type PortalChangePasswordResult = z.infer<typeof portalChangePasswordResultSchema>;

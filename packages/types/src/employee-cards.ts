import { z } from 'zod';

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) =>
        [...value].every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0)! !== 127),
      'Použijte text na jednom řádku.',
    );
const web = line(500).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Zadejte úplnou HTTPS adresu bez přihlašovacích údajů.');

/** Stable printed address. Never generated again when the person's name changes. */
export const employeeCardSlugSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const employeeCardFieldsSchema = z
  .object({
    name: line(120).min(1, 'Vyplňte jméno.'),
    role: line(120),
    company: line(120),
    tagline: line(300),
    phone: line(40).refine((v) => !v || /^\+?[0-9 ()-]{3,40}$/.test(v), 'Zkontrolujte telefon.'),
    email: line(254).refine((v) => !v || z.email().safeParse(v).success, 'Zkontrolujte e-mail.'),
    website: web,
    linkedin: web.refine((v) => {
      if (!v) return true;
      try {
        return ['linkedin.com', 'www.linkedin.com'].includes(new URL(v).hostname);
      } catch {
        return false;
      }
    }, 'Zadejte adresu LinkedIn.'),
    photoId: z.uuid().nullable(),
  })
  .strict();

export const saveEmployeeCardSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    slug: employeeCardSlugSchema,
    fields: employeeCardFieldsSchema,
    reason: line(500).min(3),
  })
  .strict();
export const employeeCardActionSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    reason: line(500).min(3),
  })
  .strict();
export const adminEmployeeCardSchema = z.object({
  slug: employeeCardSlugSchema,
  version: z.number().int().positive(),
  draft: employeeCardFieldsSchema,
  published: employeeCardFieldsSchema.nullable(),
  publishedVersion: z.number().int().positive().nullable(),
  publishedAt: z.iso.datetime().nullable(),
});
export const employeeCardResponseSchema = z.object({ card: adminEmployeeCardSchema.nullable() });
export const employeeCardPhotoSchema = z.object({ id: z.uuid() });
/** Explicit anonymous projection: no internal user id, login email, roles, scopes or draft. */
export const publicEmployeeCardSchema = employeeCardFieldsSchema
  .omit({ photoId: true })
  .extend({
    slug: employeeCardSlugSchema,
    version: z.number().int().positive(),
    hasPhoto: z.boolean(),
  })
  .strict();
export type EmployeeCardFields = z.infer<typeof employeeCardFieldsSchema>;
export type AdminEmployeeCard = z.infer<typeof adminEmployeeCardSchema>;
export type SaveEmployeeCard = z.infer<typeof saveEmployeeCardSchema>;
export type EmployeeCardAction = z.infer<typeof employeeCardActionSchema>;
export type PublicEmployeeCard = z.infer<typeof publicEmployeeCardSchema>;

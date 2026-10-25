import 'server-only';
import { z } from 'zod';

const serverEnvSchema = z.object({
  // Origin of the API as reached from the Next.js server (e.g. http://api:4000 inside Docker),
  // without a path: API routes add the `/api` prefix themselves.
  API_URL: z
    .url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).pathname === '/', 'API_URL must be an origin without a path')
    .default('http://localhost:4000'),
  // Origin of the Finance unit (ADR 0039), reached the same way; it serves /api/admin/finance/*.
  // Unset: the Finance pages report Finance as unavailable (nothing else is affected).
  FINANCE_API_URL: z
    .url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).pathname === '/', 'FINANCE_API_URL must be an origin')
    .optional(),
  // Shown as the environment badge of the shell (ADR 0008). Unset counts as development, so a
  // misconfigured server never looks like production.
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const serverEnv = serverEnvSchema.parse(process.env);

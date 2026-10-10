import 'server-only';
import { z } from 'zod';

const serverEnvSchema = z.object({
  // Origin of the API as reached from the Next.js server (e.g. http://api:4000 inside Docker),
  // without a path: API routes add the `/api` prefix themselves.
  API_URL: z
    .url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).pathname === '/', 'API_URL must be an origin without a path')
    .default('http://localhost:4000'),
});

export const serverEnv = serverEnvSchema.parse(process.env);

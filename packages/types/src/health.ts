import { z } from 'zod';

export const dependencyStatusSchema = z.enum(['up', 'down']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

/** Response contract of `GET /api/health` on the API. */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('ayvo-api'),
  environment: z.string(),
  timestamp: z.iso.datetime(),
  checks: z.object({
    database: dependencyStatusSchema,
    redis: dependencyStatusSchema,
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

import { Prisma } from '../generated/prisma/client.js';

/** A unique-constraint violation reported by Prisma (e.g. a code taken by a concurrent request). */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

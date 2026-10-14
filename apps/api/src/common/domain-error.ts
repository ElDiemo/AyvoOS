import { HttpException } from '@nestjs/common';

/**
 * A rejected business operation with a stable, language-neutral `code` (the UI maps it to a
 * localized message) and a safe English `message` for logs and API clients. Never carries
 * internal details (SQL, stack traces, paths).
 */
export function domainError(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

/** Like domainError, with safe, whitelisted details for the UI (e.g. who holds a station). */
export function domainErrorWithDetails(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
): HttpException {
  return new HttpException({ statusCode: status, code, message, details }, status);
}

export const idempotencyConflict = () =>
  domainError(
    409,
    'IDEMPOTENCY_CONFLICT',
    'This requestId was already used for a different request; send a new requestId',
  );

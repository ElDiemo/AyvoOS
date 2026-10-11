import { Prisma } from '../generated/prisma/client.js';
import { domainError } from './domain-error.js';

/**
 * Exact inventory quantities (doc 018 §2): PostgreSQL NUMERIC(19,3) ↔ Prisma.Decimal ↔ decimal
 * strings in the API. Never JavaScript floating point.
 */
export type Quantity = Prisma.Decimal;

export function quantity(value: string | number | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

/** Canonical decimal string without exponent or trailing zeros ("2", "0.5", "-1"). */
export function formatQuantity(value: Prisma.Decimal): string {
  return value.toFixed();
}

/** Rejects a quantity with more decimals than its unit allows (pieces are whole). */
export function assertUnitScale(value: Prisma.Decimal, decimalPlaces: number, field: string): void {
  if (value.decimalPlaces() > decimalPlaces) {
    throw domainError(
      422,
      'INVALID_QUANTITY',
      decimalPlaces === 0
        ? `${field} must be a whole number`
        : `${field} may have at most ${decimalPlaces} decimal places`,
    );
  }
}

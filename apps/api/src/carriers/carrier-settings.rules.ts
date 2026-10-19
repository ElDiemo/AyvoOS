import type { CarrierSettingsProblem } from '@ayvo/types';
import type { CarrierSettingsSnapshot } from './carrier.js';
import type { CredentialState } from './carrier-credentials.service.js';
import { isPplConnection } from './ppl/ppl-connections.js';

export interface SiteCarrierRow {
  enabled: boolean;
  connection: string | null;
  senderName: string | null;
  senderStreet: string | null;
  senderCity: string | null;
  senderPostalCode: string | null;
  senderCountry: string | null;
  senderContact: string | null;
  senderPhone: string | null;
  senderEmail: string | null;
  productCode: string | null;
  labelFormat: string;
  labelDpi: number;
  labelLayout: string;
  verifiedAt: Date | null;
  verifiedConnection: string | null;
  verifiedAccount: string | null;
  verifiedProducts: unknown;
}

const verifiedCodes = (row: SiteCarrierRow) =>
  Array.isArray(row.verifiedProducts)
    ? (row.verifiedProducts as { code?: unknown }[]).map((p) => String(p.code))
    : [];

/**
 * Why a site's PPL settings cannot take a new shipment (empty = complete). Required sender
 * fields follow the PPL CPL address model (name, street, city, zip code, country when a sender is
 * sent); the product must come from the list read during "Ověřit připojení" with the same
 * connection. Never guessed: no depot, no product taken from an example.
 */
export function carrierProblems(
  row: SiteCarrierRow | null,
  /** The credentials of the row's connection (never their values). */
  credentials: CredentialState | null,
): CarrierSettingsProblem[] {
  if (!row) return ['NO_CONNECTION', 'SENDER_INCOMPLETE', 'NOT_VERIFIED', 'NO_PRODUCT', 'DISABLED'];
  const problems: CarrierSettingsProblem[] = [];
  if (!row.connection) problems.push('NO_CONNECTION');
  else if (!isPplConnection(row.connection)) problems.push('UNKNOWN_CONNECTION');
  else if (credentials?.credentials === 'UNREADABLE') problems.push('CREDENTIALS_UNREADABLE');
  else if (credentials?.credentials !== 'SET') problems.push('CREDENTIALS_MISSING');
  if (
    !row.senderName ||
    !row.senderStreet ||
    !row.senderCity ||
    !row.senderPostalCode ||
    !row.senderCountry
  ) {
    problems.push('SENDER_INCOMPLETE');
  }
  if (!row.verifiedAt) problems.push('NOT_VERIFIED');
  // A verification counts only for the same connection AND the same carrier account.
  else if (
    row.verifiedConnection !== row.connection ||
    (credentials?.account && row.verifiedAccount !== credentials.account)
  )
    problems.push('VERIFIED_WITH_ANOTHER_CONNECTION');
  if (!row.productCode) problems.push('NO_PRODUCT');
  else if (row.verifiedAt && !verifiedCodes(row).includes(row.productCode)) {
    problems.push('PRODUCT_NOT_VERIFIED');
  }
  if (!row.enabled) problems.push('DISABLED');
  return problems;
}

export const isVerifiedProduct = (row: SiteCarrierRow, code: string) =>
  verifiedCodes(row).includes(code);

/** The settings a new request uses — copied into the request (snapshot). */
export function settingsSnapshot(row: SiteCarrierRow): CarrierSettingsSnapshot {
  return {
    service: row.productCode,
    label: {
      format: row.labelFormat === 'ZPL' ? 'ZPL' : 'PDF',
      dpi: row.labelDpi,
      complete: row.labelLayout === 'A4',
    },
    sender: {
      name: row.senderName!,
      addressLine1: row.senderStreet!,
      addressLine2: null,
      postalCode: row.senderPostalCode!,
      city: row.senderCity!,
      countryCode: row.senderCountry!,
      contactName: row.senderContact,
      phone: row.senderPhone,
      email: row.senderEmail,
    },
  };
}

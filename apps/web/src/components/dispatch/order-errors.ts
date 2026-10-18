import { catalogErrorText } from '@/components/catalog/form-kit';
import { hotelsCs } from '@/i18n/cs/hotels';
import { ordersCs } from '@/i18n/cs/orders';
import { shipmentsCs } from '@/i18n/cs/shipments';
import { ClientApiError } from '@/lib/client-api';

/** Czech text of a refused hotel/order/picking request (never raw server text). */
export function orderErrorText(error: unknown): string {
  if (error instanceof ClientApiError && error.code) {
    const text =
      ordersCs.errors[error.code] ?? shipmentsCs.errors[error.code] ?? hotelsCs.errors[error.code];
    if (text) return text;
  }
  return catalogErrorText(error);
}

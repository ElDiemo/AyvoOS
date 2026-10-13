import { requirePermission } from '@/lib/session';

/**
 * Výroba → Produkty a receptury (doc 023, issue #17). Company-wide: needs only `catalog:read` —
 * no production access and no active site; the API enforces the same permission on every request.
 */
export default async function CatalogLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('catalog:read');
  return children;
}

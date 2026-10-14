import { requirePermission } from '@/lib/session';

/**
 * Výroba → Bedny (physical crates, doc 025 A1): needs `crates:read` and the active site (the API
 * refuses otherwise); the API enforces the same permission on every request.
 */
export default async function CratesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('crates:read');
  return children;
}

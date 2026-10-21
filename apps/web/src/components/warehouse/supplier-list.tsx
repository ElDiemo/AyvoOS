'use client';

import type { Supplier } from '@ayvo/types';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Card, EmptyState, inputClass } from '@/components/ui';
import { warehouseCs } from '@/i18n/cs/warehouse';

const s = warehouseCs.suppliers;

const fold = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Searchable supplier list (doc 033): name, country / city, identifier, contact, state. */
export function SupplierList({ suppliers }: { suppliers: Supplier[] }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const showContact = suppliers.some((x) => x.contact);
  const q = fold(query.trim());
  const shown = suppliers.filter(
    (x) =>
      (archived || !x.archivedAt) &&
      (!q ||
        fold(
          [x.name, x.companyId, x.vatId, x.address.city, x.address.countryCode, x.contact?.name]
            .filter(Boolean)
            .join(' '),
        ).includes(q)),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label htmlFor={`${id}-q`} className="flex min-w-0 flex-col gap-1 text-sm sm:w-80">
          {s.search}
          <input
            id={`${id}-q`}
            type="search"
            value={query}
            placeholder={s.searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          {s.showArchived}
        </label>
      </div>
      <Card className="p-0">
        {shown.length === 0 ? (
          <EmptyState>{suppliers.length === 0 ? s.empty : s.noMatch}</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-100" data-testid="suppliers">
            {shown.map((x) => {
              const place = [x.address.countryCode, x.address.city].filter(Boolean).join(' · ');
              return (
                <li key={x.id} className={x.archivedAt ? 'text-stone-400' : ''}>
                  <Link
                    href={`/warehouse/suppliers/${x.id}`}
                    className="grid grid-cols-1 gap-1 px-4 py-3 hover:bg-stone-50 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_6rem] sm:items-center sm:gap-4 sm:px-6"
                    data-testid="supplier-row"
                  >
                    <span className="font-medium wrap-anywhere">{x.name}</span>
                    <span className="text-sm text-stone-600">
                      <span className="sr-only">{s.place}: </span>
                      {place || '—'}
                    </span>
                    <span className="font-mono text-xs text-stone-600 wrap-anywhere">
                      <span className="sr-only">{s.companyId}: </span>
                      {x.companyId ?? '—'}
                    </span>
                    <span className="text-sm text-stone-600 wrap-anywhere">
                      {showContact && (
                        <>
                          <span className="sr-only">{s.contact}: </span>
                          {[x.contact?.name, x.contact?.phone].filter(Boolean).join(', ') || '—'}
                        </>
                      )}
                    </span>
                    <span className="text-xs sm:text-right">
                      {x.archivedAt ? (
                        s.archived
                      ) : (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800">
                          {s.active}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

import type { AccountingExportLine } from '@ayvo/types';
import Link from 'next/link';
import { financeCs as t } from '@/i18n/cs/finance';
import { fileSize, financeAmount, financeDate } from './finance-format';

/** The documents of an export (or of its preview / later changes). */
export function ExportLines({ lines }: { lines: readonly AccountingExportLine[] }) {
  return (
    <ul className="divide-y divide-stone-100 text-sm">
      {lines.map((l) => (
        <li
          key={`${l.code}-${l.version}`}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
        >
          <Link href={`/finance/documents/${l.code}`} className="font-mono underline">
            {l.code}
          </Link>
          <span className="min-w-0 flex-1">
            {l.supplier} · {t.kinds[l.kind]} {l.documentNumber} · {financeDate(l.issuedOn)}
          </span>
          <span className="tabular-nums">{financeAmount(l.totalAmount, l.currency)}</span>
          <span className="text-xs text-stone-500">
            {t.exports.changes[l.change]}
            {l.change !== 'VOIDED' && ` · ${fileSize(l.byteSize)}`} · v{l.version}
          </span>
        </li>
      ))}
    </ul>
  );
}

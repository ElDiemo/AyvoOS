'use client';

import type { HotelDeliveries } from '@ayvo/types';
import { useState } from 'react';
import { EmptyState } from '@/components/ui';
import { hotelsCs } from '@/i18n/cs/hotels';

const t = hotelsCs.deliveries;

const monthCs = (m: string) => {
  const [y, mm] = m.split('-');
  return `${Number(mm)}/${y}`;
};

/**
 * Dodávky hotelu (doc 032 §4): a table per month and product (delivered and still open,
 * separately) and one simple chart of delivered bottles per month. Delivered comes only from
 * parcels the carrier confirmed delivered; nothing ordered or handed over is drawn as delivered.
 */
export function DeliveriesOverview({ data }: { data: HotelDeliveries }) {
  if (data.months.length === 0) return <EmptyState>{t.empty}</EmptyState>;
  const rows = data.months.flatMap((m) => m.products.map((p) => ({ month: m.month, ...p })));
  const perMonth = data.months.map((m) => ({
    month: m.month,
    bottles: m.products.reduce((n, p) => n + p.deliveredBottles, 0),
  }));
  return (
    <div className="flex flex-col gap-6 text-sm">
      <p className="text-stone-600">{t.intro}</p>
      <DeliveredChart months={perMonth} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm" data-testid="deliveries-table">
          <thead className="text-xs text-stone-500">
            <tr className="border-b border-stone-200">
              <th className="py-2 pr-3 font-medium">{t.month}</th>
              <th className="py-2 pr-3 font-medium">{t.product}</th>
              <th className="py-2 pr-3 text-right font-medium">{t.deliveredBottles}</th>
              <th className="py-2 pr-3 text-right font-medium">{t.deliveredCrates}</th>
              <th className="py-2 pr-3 text-right font-medium">{t.openBottles}</th>
              <th className="py-2 text-right font-medium">{t.openCrates}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.month}-${r.productCode}`}
                className="border-b border-stone-100"
                data-testid={`delivery-${r.month}-${r.productCode}`}
              >
                <td className="py-2 pr-3 tabular-nums">{monthCs(r.month)}</td>
                <td className="py-2 pr-3">{r.productName}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.deliveredBottles}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.deliveredCrates}</td>
                <td className="py-2 pr-3 text-right text-stone-600 tabular-nums">
                  {r.openBottles}
                </td>
                <td className="py-2 text-right text-stone-600 tabular-nums">{r.openCrates}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500">{t.noConsumption}</p>
    </div>
  );
}

/** One series, so no legend box — the title names it; each bar has a hover tooltip. */
function DeliveredChart({ months }: { months: { month: string; bottles: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...months.map((m) => m.bottles), 0);
  const height = 140;
  const bar = 28;
  const gap = 14;
  const width = Math.max(months.length * (bar + gap) + gap, 160);
  const y = (v: number) => (max === 0 ? 0 : Math.round((v / max) * (height - 24)));
  return (
    <figure className="flex flex-col gap-2" data-testid="deliveries-chart">
      <figcaption className="text-xs font-medium uppercase tracking-wide text-stone-500">
        {t.chartTitle}
      </figcaption>
      {max === 0 ? (
        <p className="text-stone-600" data-testid="deliveries-chart-empty">
          {t.chartEmpty}
        </p>
      ) : (
        <div className="relative max-w-full overflow-x-auto">
          <svg
            role="img"
            aria-label={t.chartAlt(
              months.map((m) => `${monthCs(m.month)}: ${m.bottles}`).join(', '),
            )}
            width={width}
            height={height + 20}
            className="block"
          >
            {/* Recessive baseline. */}
            <line
              x1={0}
              x2={width}
              y1={height}
              y2={height}
              className="stroke-stone-300"
              strokeWidth={1}
            />
            {months.map((m, i) => {
              const h = y(m.bottles);
              const x = gap + i * (bar + gap);
              return (
                <g
                  key={m.month}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                >
                  {/* Hit target bigger than the mark. */}
                  <rect
                    x={x - gap / 2}
                    y={0}
                    width={bar + gap}
                    height={height}
                    fill="transparent"
                  />
                  {h > 0 && (
                    <path
                      d={`M${x},${height} V${height - h + 4} q0,-4 4,-4 H${x + bar - 4} q4,0 4,4 V${height} Z`}
                      fill="#0369a1"
                      opacity={hover === null || hover === i ? 1 : 0.55}
                    />
                  )}
                  <text
                    x={x + bar / 2}
                    y={height + 14}
                    textAnchor="middle"
                    className="fill-stone-500 text-[10px]"
                  >
                    {monthCs(m.month)}
                  </text>
                  <title>{`${monthCs(m.month)}: ${m.bottles}`}</title>
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-0 rounded border border-stone-200 bg-white px-2 py-1 text-xs shadow-sm"
              style={{ left: gap + hover * (bar + gap) }}
              data-testid="deliveries-tooltip"
            >
              <span className="font-medium">{monthCs(months[hover]!.month)}</span> ·{' '}
              <span className="tabular-nums">{months[hover]!.bottles}</span>{' '}
              {t.deliveredBottles.toLowerCase()}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

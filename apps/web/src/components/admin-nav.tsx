'use client';

import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/bottles', label: 'Bottles' },
  { href: '/batches', label: 'Creation batches' },
  { href: '/label-templates', label: 'Label templates' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition',
              active
                ? 'bg-stone-900 text-white'
                : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

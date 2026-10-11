'use client';

import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** `also`: other path prefixes that belong to the same module (e.g. old batch detail links). */
const items = [
  { href: '/bottles', label: 'Bottles', also: ['/batches'] },
  { href: '/label-templates', label: 'Label templates', also: [] },
];

const within = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto">
      {items.map((item) => {
        const active = [item.href, ...item.also].some((prefix) => within(pathname, prefix));
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

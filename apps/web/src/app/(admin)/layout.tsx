import Link from 'next/link';
import { AdminNav } from '@/components/admin-nav';

/** Admin shell. On DEV the whole site is behind Basic Auth; app-level auth comes later. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="text-lg font-semibold tracking-[0.2em] text-stone-900">
            AYVO<span className="ml-2 font-normal tracking-normal text-stone-400">OS</span>
          </Link>
          <AdminNav />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}

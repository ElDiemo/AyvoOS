import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import './globals.css';
import { cs } from '@/i18n/cs';

export const metadata: Metadata = {
  title: { default: cs.brand, template: `%s – ${cs.brand}` },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/**
 * Rendered per request: the nonce of the page's Content Security Policy (src/proxy.ts) is new on
 * every answer, so no page may be prerendered at build time.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html lang="cs">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}

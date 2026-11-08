import type { Metadata, Viewport } from 'next';
import './globals.css';
import { cs } from '@/i18n/cs';

export const metadata: Metadata = {
  title: cs.brand,
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}

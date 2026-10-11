import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AYVO OS',
  description: 'Provozní systém AYVO pro cirkulární hotelovou kosmetiku',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}

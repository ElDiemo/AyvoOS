import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AYVO OS',
  description: 'Operating system for the AYVO circular hotel amenity service',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}

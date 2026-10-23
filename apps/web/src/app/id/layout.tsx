import type { Metadata } from 'next';

/**
 * Public business cards keep the favicon of the existing id.ayvo.co (public/employee-card); the
 * rest of AYVO OS keeps its own icon.
 */
export const metadata: Metadata = {
  icons: { icon: '/employee-card/favicon.ico' },
};

export default function EmployeeCardLayout({ children }: { children: React.ReactNode }) {
  return children;
}

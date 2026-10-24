import type { Metadata } from 'next';
import { NativeSignIn } from '@/components/native-sign-in';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Nastavení přístupu – AYVO OS',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};
export default function ActivatePage() {
  return <NativeSignIn mode="activate" />;
}

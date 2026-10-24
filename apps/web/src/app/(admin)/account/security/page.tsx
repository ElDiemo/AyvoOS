import type { Metadata } from 'next';
import { NativeSignIn } from '@/components/native-sign-in';
import { currentUser } from '@/lib/session';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Zabezpečení účtu – AYVO OS',
  robots: { index: false, follow: false },
};
export default async function SecurityPage() {
  await currentUser();
  return <NativeSignIn mode="replace" />;
}

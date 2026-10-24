import type { Metadata } from 'next';
import { NativeSignIn } from '@/components/native-sign-in';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Nové heslo – AYVO OS',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};
export default function ResetPasswordPage() {
  return <NativeSignIn mode="reset" />;
}

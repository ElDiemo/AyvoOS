import type { Metadata } from 'next';
import { NativeSignIn } from '@/components/native-sign-in';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Obnova hesla – AYVO OS',
  robots: { index: false, follow: false },
};
export default function ForgotPasswordPage() {
  return <NativeSignIn mode="forgot" />;
}

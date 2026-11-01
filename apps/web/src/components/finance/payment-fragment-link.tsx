'use client';

import { paymentCodeSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Links from before the bounded list point at /finance/payments#PP-…: the server never sees the
 * fragment, so a payment that is not on this page opens its detail instead of nothing.
 */
export function PaymentFragmentLink() {
  const router = useRouter();
  useEffect(() => {
    const code = window.location.hash.slice(1);
    if (paymentCodeSchema.safeParse(code).success && !document.getElementById(code))
      router.replace(`/finance/payments/${code}`);
  }, [router]);
  return null;
}

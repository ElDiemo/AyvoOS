import 'server-only';
import {
  portalHotelSchema,
  portalInvoicePageSchema,
  portalInvoiceSchema,
  portalSessionViewSchema,
} from '@ayvo/types';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { contractJson, PortalUnauthenticated } from './backend';
import { readCookie, SESSION_COOKIE } from './session';

/** The page's session, checked by the core now; none (or ended) → the sign-in page. */
export async function portalSession() {
  const session = await readCookie(SESSION_COOKIE);
  if (!session) redirect('/login');
  try {
    const view = await contractJson('core', 'session', portalSessionViewSchema, { session });
    return { token: session, view };
  } catch (error) {
    if (error instanceof PortalUnauthenticated) redirect('/login');
    throw error;
  }
}

export const myHotels = (session: string) =>
  contractJson('core', 'hotels', z.array(portalHotelSchema), { session });
export const myHotel = (session: string, id: string) =>
  contractJson('core', `hotels/${encodeURIComponent(id)}`, portalHotelSchema, { session });
export const myInvoices = (session: string, page: number) =>
  contractJson('finance', `invoices?page=${page}&pageSize=20`, portalInvoicePageSchema, {
    session,
  });
export const myInvoice = (session: string, id: string) =>
  contractJson('finance', `invoices/${encodeURIComponent(id)}`, portalInvoiceSchema, { session });

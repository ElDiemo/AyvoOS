import 'server-only';
import { PortalRefusal, PortalUnavailable } from './backend';

/** At most this many hotels are read at once (portal-web's core budget is 8 calls). */
const PER_HOTEL_READS = 3;

/**
 * One contract read per hotel of the account (the core checks the grant every time), a few at a
 * time. A hotel whose read is unavailable, or whose grant ended meanwhile (404), gets null: only
 * its own block says so, the others show. Any other error (e.g. the session ended) is thrown.
 */
export async function perHotel<T>(ids: string[], read: (id: string) => Promise<T>) {
  const out = new Map<string, T | null>();
  for (let i = 0; i < ids.length; i += PER_HOTEL_READS) {
    const batch = ids.slice(i, i + PER_HOTEL_READS);
    const values = await Promise.all(
      batch.map((id) =>
        read(id).catch((error: unknown) => {
          if (error instanceof PortalUnavailable || error instanceof PortalRefusal) return null;
          throw error;
        }),
      ),
    );
    batch.forEach((id, k) => out.set(id, values[k] ?? null));
  }
  return out;
}

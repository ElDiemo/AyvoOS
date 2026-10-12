import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * Proxies whose X-Forwarded-For is trusted (TRUSTED_PROXY_CIDRS). Behind Caddy the API sees the
 * proxy's address; Caddy overwrites X-Forwarded-For with the real client (it trusts no incoming
 * value), so the right-most address not belonging to a trusted proxy is the client. A request
 * from anyone else is judged by its socket address — a client cannot choose its own IP.
 */
export class TrustedProxies {
  private readonly list = new BlockList();
  readonly empty: boolean;

  constructor(cidrs: readonly string[]) {
    for (const cidr of cidrs) {
      const [address, prefix] = cidr.split('/');
      const type = isIP(address ?? '') === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) this.list.addAddress(address!, type);
      else this.list.addSubnet(address!, Number(prefix), type);
    }
    this.empty = cidrs.length === 0;
  }

  has(address: string): boolean {
    const plain = normalize(address);
    const type = isIP(plain);
    if (this.empty || type === 0) return false;
    return this.list.check(plain, type === 6 ? 'ipv6' : 'ipv4');
  }
}

/** "::ffff:10.0.0.1" → "10.0.0.1" (IPv4 peers on a dual-stack socket). */
function normalize(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

/** The client address of a request, honouring X-Forwarded-For only from trusted proxies. */
export function clientIp(req: IncomingMessage, proxies: TrustedProxies): string {
  const peer = normalize(req.socket?.remoteAddress ?? '');
  if (!proxies.has(peer)) return peer || 'unknown';
  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((h) => normalize(h))
    .filter((h) => isIP(h) !== 0);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!proxies.has(chain[i]!)) return chain[i]!;
  }
  return chain[0] ?? peer;
}

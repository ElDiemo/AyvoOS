import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { clientIp, TrustedProxies } from './client-ip.js';

const req = (remoteAddress: string, xff?: string) =>
  ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }) as unknown as IncomingMessage;

describe('client IP behind a trusted proxy', () => {
  const caddy = new TrustedProxies(['172.16.0.0/12', '::1']);

  it('ignores X-Forwarded-For from an untrusted peer (no IP spoofing)', () => {
    expect(clientIp(req('203.0.113.9', '198.51.100.1'), caddy)).toBe('203.0.113.9');
    expect(clientIp(req('203.0.113.9', '198.51.100.1'), new TrustedProxies([]))).toBe(
      '203.0.113.9',
    );
  });

  it('takes the right-most untrusted address from a trusted proxy', () => {
    expect(clientIp(req('172.18.0.5', '198.51.100.1'), caddy)).toBe('198.51.100.1');
    // A client-supplied left part cannot win over what the proxy appended.
    expect(clientIp(req('::ffff:172.18.0.5', '1.2.3.4, 198.51.100.1'), caddy)).toBe('198.51.100.1');
    expect(clientIp(req('172.18.0.5', 'garbage, 198.51.100.7, 172.18.0.9'), caddy)).toBe(
      '198.51.100.7',
    );
  });

  it('falls back to the peer when a trusted proxy sends no usable header', () => {
    expect(clientIp(req('172.18.0.5'), caddy)).toBe('172.18.0.5');
    expect(clientIp(req('::1', 'not-an-ip'), caddy)).toBe('::1');
  });
});

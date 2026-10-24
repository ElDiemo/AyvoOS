import { createServer, type Server, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { GOOGLE_SMTP_RELAY, smtpTransportOptions } from './native-tokens.service.js';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ayvo_test',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_ENCRYPTION_KEY: '5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28', // synthetic test value
  AUTH_MAIL_FROM: 'system@ayvo.test',
};
const relayEnv = () =>
  loadEnv({
    ...base,
    AUTH_MAIL_DRIVER: 'google-relay',
    APP_PUBLIC_ORIGIN: 'https://app.example.test',
  });

/** A local SMTP stub that offers no STARTTLS and accepts anything: what a relay must refuse. */
let server: Server | null = null;
const seen: string[] = [];
const ehlo: string[] = [];
async function plaintextSmtp(host: string): Promise<number> {
  server = createServer((socket: Socket) => {
    seen.push('connect');
    socket.write('220 stub ESMTP\r\n');
    socket.on('data', (chunk) => {
      const line = chunk.toString('utf8');
      seen.push(line.trim().split(/\s/)[0]!.toUpperCase());
      if (/^EHLO /i.test(line)) ehlo.push(line.trim().slice(5));
      if (/^(EHLO|HELO)/i.test(line)) socket.write('250-stub\r\n250 AUTH PLAIN\r\n');
      else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    });
  });
  await new Promise<void>((done) => server!.listen(0, host, done));
  return (server.address() as { port: number }).port;
}
afterEach(async () => {
  seen.length = 0;
  ehlo.length = 0;
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
});

describe('authentication mail transport (no external connection)', () => {
  it('google-relay: fixed Google host and port, STARTTLS required, verified certificate, IPv4 socket, no credentials', () => {
    const options = smtpTransportOptions(relayEnv())!;
    expect(options).toMatchObject({
      host: GOOGLE_SMTP_RELAY.host,
      port: 587,
      secure: false,
      requireTLS: true,
      localAddress: '0.0.0.0',
      name: 'app.example.test',
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
    expect(GOOGLE_SMTP_RELAY).toEqual({ host: 'smtp-relay.gmail.com', port: 587 });
    expect(options.auth).toBeUndefined();
    expect(JSON.stringify(options)).not.toMatch(/ignoreTLS|rejectUnauthorized":false/);
  });

  it('password mode keeps requiring and using both credentials', () => {
    const env = loadEnv({
      ...base,
      AUTH_MAIL_DRIVER: 'smtp',
      AUTH_SMTP_HOST: 'smtp.example.test',
      AUTH_SMTP_PORT: '587',
      AUTH_SMTP_USER: 'synthetic-user',
      AUTH_SMTP_PASSWORD: 'synthetic-password',
    });
    expect(smtpTransportOptions(env)).toMatchObject({
      host: 'smtp.example.test',
      port: 587,
      requireTLS: true,
      auth: { user: 'synthetic-user', pass: 'synthetic-password' },
    });
    expect(() =>
      loadEnv({ ...base, AUTH_MAIL_DRIVER: 'smtp', AUTH_SMTP_HOST: 'smtp.example.test' }),
    ).toThrow(/SMTP host, credentials/);
  });

  it('the relay settings never deliver over a server without STARTTLS (no anonymous plaintext)', async () => {
    const port = await plaintextSmtp('127.0.0.1');
    const transport = nodemailer.createTransport({
      ...smtpTransportOptions(relayEnv())!,
      host: '127.0.0.1',
      port,
    });
    await expect(
      transport.sendMail({ from: 'system@ayvo.test', to: 'x@ayvo.test', text: 'synthetic' }),
    ).rejects.toThrow();
    transport.close();
    expect(seen).not.toContain('MAIL');
    expect(seen).not.toContain('DATA');
    // EHLO announces the application's host name, never the container's random one.
    expect(ehlo).toEqual(['app.example.test']);
  });

  it('the relay settings do not connect over IPv6 (the Google allowlist is IPv4 only)', async () => {
    let port: number;
    try {
      port = await plaintextSmtp('::1');
    } catch {
      return; // No IPv6 loopback on this host: nothing to prove here.
    }
    const transport = nodemailer.createTransport({
      ...smtpTransportOptions(relayEnv())!,
      host: '::1',
      port,
    });
    await expect(transport.verify()).rejects.toThrow();
    transport.close();
    expect(seen).toEqual([]);
  });
});

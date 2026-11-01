import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  SmtpInvoiceMailTransport,
  type OutgoingInvoiceMail,
} from '../src/finance/invoice-mail-transport.js';

const mail: OutgoingInvoiceMail = {
  from: { name: 'Test', address: 'odesilatel@example.test' },
  replyTo: 'odesilatel@example.test',
  to: 'prijemce@example.test',
  messageId: '<lhuta@example.test>',
  subject: 'Test',
  text: 'Test',
  html: '<p>Test</p>',
  filename: 'test.pdf',
  pdf: Buffer.from('%PDF-test'),
};

/** A self-signed certificate for localhost, made for this run only. */
const dir = mkdtempSync(join(tmpdir(), 'ayvo-mail-deadline-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-keyout',
    'key.pem',
    '-out',
    'cert.pem',
  ],
  { cwd: dir, stdio: 'ignore' },
);
const cert = readFileSync(join(dir, 'cert.pem'));
const key = readFileSync(join(dir, 'key.pem'));

type Script = { tls?: boolean };

/**
 * A relay that never finishes: after the message it keeps answering with continuation lines, so the
 * socket stays active and no inactivity timeout can end it. It counts connections open at once.
 */
const stallingRelay = async ({ tls }: Script = {}) => {
  const seen = { connections: 0, active: 0, maxActive: 0, mailCommands: 0, messages: 0 };
  const keepalives = new Set<NodeJS.Timeout>();
  const speak = (socket: Socket, initial: Socket | TLSSocket) => {
    let buffered = '';
    let inData = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      if (inData) {
        if (!buffered.includes('\r\n.\r\n')) return;
        inData = false;
        buffered = '';
        seen.messages++;
        const keepalive = setInterval(() => {
          if (!socket.destroyed) socket.write('250-still working\r\n');
        }, 20);
        keepalives.add(keepalive);
        socket.once('close', () => clearInterval(keepalive));
        return;
      }
      let i: number;
      while ((i = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, i).toUpperCase();
        buffered = buffered.slice(i + 2);
        if (line.startsWith('EHLO')) {
          const secured = socket !== initial || socket instanceof TLSSocket;
          socket.write(
            tls && !secured ? '250-relay.test\r\n250 STARTTLS\r\n' : '250 relay.test\r\n',
          );
        } else if (line.startsWith('STARTTLS')) {
          socket.removeAllListeners('data');
          socket.write('220 go\r\n', () => {
            const secure = new TLSSocket(socket, { isServer: true, cert, key });
            speak(secure, initial);
          });
          return;
        } else if (line.startsWith('MAIL')) {
          seen.mailCommands++;
          socket.write('250 ok\r\n');
        } else if (line.startsWith('DATA')) {
          inData = true;
          socket.write('354 go\r\n');
          return;
        } else socket.write('250 ok\r\n');
      }
    });
  };
  const server: Server = createServer((socket) => {
    seen.connections++;
    seen.active++;
    seen.maxActive = Math.max(seen.maxActive, seen.active);
    socket.once('close', () => seen.active--);
    speak(socket, socket);
    socket.write('220 relay.test ESMTP\r\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    seen,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((done) => {
        keepalives.forEach(clearInterval);
        server.close(() => done());
      }),
  };
};

const gone = async (seen: { active: number }) => {
  const until = Date.now() + 2_000;
  while (seen.active > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
  return seen.active;
};

describe('the whole-send deadline ends the connection', () => {
  const relays: Awaited<ReturnType<typeof stallingRelay>>[] = [];
  const started = async (script?: Script) => {
    const relay = await stallingRelay(script);
    relays.push(relay);
    return relay;
  };
  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.close()));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('an active relay past the limit: UNCERTAIN, socket closed, the next message stays within one connection', async () => {
    const relay = await started();
    const transport = new SmtpInvoiceMailTransport(
      { host: '127.0.0.1', port: relay.port, secure: false, ignoreTLS: true },
      400,
    );
    const first = Date.now();
    await expect(transport.send(mail)).resolves.toEqual({
      kind: 'UNCERTAIN',
      code: 'CONNECTION_LOST',
    });
    expect(Date.now() - first).toBeLessThan(5_000);
    expect(relay.seen.messages).toBe(1);
    expect(await gone(relay.seen)).toBe(0);
    await expect(transport.send(mail)).resolves.toMatchObject({ kind: 'UNCERTAIN' });
    expect(await gone(relay.seen)).toBe(0);
    // One connection per sending, never a retry, never two at once.
    expect(relay.seen.connections).toBe(2);
    expect(relay.seen.maxActive).toBe(1);
  });

  it('after STARTTLS with a verified certificate the same limit ends the encrypted session', async () => {
    const relay = await started({ tls: true });
    const transport = new SmtpInvoiceMailTransport(
      {
        host: 'localhost',
        port: relay.port,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: cert },
      },
      800,
    );
    await expect(transport.send(mail)).resolves.toMatchObject({ kind: 'UNCERTAIN' });
    expect(relay.seen.messages).toBe(1);
    expect(await gone(relay.seen)).toBe(0);
  });

  it('TLS is not weakened: an unverifiable certificate or no STARTTLS sends nothing', async () => {
    const untrusted = await started({ tls: true });
    const verifying = (port: number) =>
      new SmtpInvoiceMailTransport(
        {
          host: 'localhost',
          port,
          secure: false,
          requireTLS: true,
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        },
        5_000,
      );
    // Unverifiable: the classification stays conservative, what matters is that no message started.
    expect((await verifying(untrusted.port).send(mail)).kind).not.toBe('ACCEPTED');
    expect(untrusted.seen.mailCommands).toBe(0);
    const plain = await started();
    expect((await verifying(plain.port).send(mail)).kind).not.toBe('ACCEPTED');
    expect(plain.seen.mailCommands).toBe(0);
  });

  it('nothing listening: provably not sent', async () => {
    const relay = await stallingRelay();
    const { port } = relay;
    await relay.close();
    await expect(
      new SmtpInvoiceMailTransport({
        host: '127.0.0.1',
        port,
        secure: false,
        ignoreTLS: true,
      }).send(mail),
    ).resolves.toEqual({ kind: 'NOT_SENT', code: 'RELAY_UNREACHABLE' });
  });
});

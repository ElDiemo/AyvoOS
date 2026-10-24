import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

/**
 * The real outbox path (invitation → deliverPending → sendMail) builds a real MIME message:
 * nodemailer's stream transport stands in for the SMTP connection (the TLS/EHLO/IPv4 transport
 * itself is tested in native-mail-transport.test.ts and unchanged). Synthetic users only; the
 * link is checked, never printed.
 */
describe.skipIf(!hasDatabase)('authentication e-mail as sent', () => {
  let t: TestApp;
  const sent: { raw: string; envelope: { from: string; to: string[] } }[] = [];

  beforeAll(async () => {
    t = await createTestApp(
      { AUTH_PROVIDER: 'local', AUTH_MAIL_DRIVER: 'smtp', AUTH_MAIL_FROM: 'system@ayvo.test' },
      {},
      { auth: 'real' },
    );
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const tokens = t.app.get(NativeTokensService) as unknown as {
      smtp: { sendMail: (m: object) => Promise<unknown>; close: () => void };
    };
    tokens.smtp.close();
    tokens.smtp = {
      sendMail: async (message: object) => {
        const info = (await stream.sendMail(message)) as {
          message: Buffer;
          envelope: { from: string; to: string[] };
        };
        sent.push({ raw: info.message.toString('utf8'), envelope: info.envelope });
        return info;
      },
      close: () => stream.close(),
    };
  });
  afterAll(() => t?.close());

  it('activation: From "AYVO OS", text + HTML alternatives and the inline logo by CID', async () => {
    const user = await t.prisma.user.create({
      data: { email: `native-mail-${randomUUID()}@ayvo.test`, displayName: 'Mail Test' },
    });
    await t.app.get(InvitationsService).send(null, user.id, randomUUID(), 'Synthetic mail test');
    await t.app.get(NativeTokensService).deliverPending();
    const mail = sent.find((m) => m.envelope.to.includes(user.email))!;
    expect(mail).toBeTruthy();
    expect(mail.envelope.from).toBe('system@ayvo.test');
    const raw = mail.raw;
    expect(raw).toMatch(/^From: AYVO OS <system@ayvo\.test>$/m);
    expect(raw).toMatch(new RegExp(`^To: ${user.email.replace(/[.]/g, '\\.')}$`, 'm'));
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m); // Czech subject, encoded
    expect(raw).toMatch(/Content-Type: multipart\/(related|mixed)/);
    expect(raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(raw).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(raw).toMatch(/Content-Type: text\/html; charset=utf-8/);
    expect(raw).toMatch(/Content-Type: image\/png; name=ayvo\.png/);
    expect(raw).toMatch(/Content-Id: <ayvo-logo@ayvo-os>/i);
    expect(raw).toMatch(/Content-Disposition: inline/);
    // The one-time link exists in the message (decoded parts), with its fragment, once per part.
    const token = await t.prisma.nativeAuthToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(token.sentAt).not.toBeNull();
    expect(token.deliveryCiphertext).toBeNull();
    const decoded = raw
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    expect(decoded).toContain(`${TEST_APP_ORIGIN}/activate#token=`);
    expect(decoded).toMatch(/\/activate#token=[A-Za-z0-9_-]{43}/);
    expect(decoded).not.toMatch(/[?&]token=/);
  });
});

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { randomToken } from './crypto.js';
import {
  NativeSecretBox,
  nativeTokenHash,
  type NativeActionPurpose,
} from './native-credentials.js';

export const NATIVE_SECRET_BOX = Symbol('NATIVE_SECRET_BOX');
export const NATIVE_PASSWORDS = Symbol('NATIVE_PASSWORDS');

/** Durable encrypted email material, not a hosted identity service or a log-based mail fallback. */
@Injectable()
export class NativeTokensService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NativeTokensService.name);
  private readonly smtp: Transporter | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly testMail: { to: string; url: string }[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(NATIVE_SECRET_BOX) private readonly box: NativeSecretBox,
  ) {
    this.smtp =
      env.AUTH_MAIL_DRIVER === 'smtp'
        ? nodemailer.createTransport({
            host: env.AUTH_SMTP_HOST,
            port: env.AUTH_SMTP_PORT,
            secure: env.AUTH_SMTP_PORT === 465,
            requireTLS: true,
            auth: { user: env.AUTH_SMTP_USER!, pass: env.AUTH_SMTP_PASSWORD! },
            tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 10_000,
            disableFileAccess: true,
            disableUrlAccess: true,
            logger: false,
            debug: false,
          })
        : null;
  }

  onModuleInit(): void {
    if (this.env.APP_ENV !== 'test') {
      this.timer = setInterval(() => {
        void this.deliverPending().catch(() =>
          this.logger.warn('Authentication mail queue unavailable'),
        );
      }, 5000);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.smtp?.close();
  }

  async issue(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      purpose: NativeActionPurpose;
      credentialRevision: number;
      ttlMs: number;
    },
  ) {
    const token = randomToken();
    const route = input.purpose === 'ENROLL' ? 'activate' : 'reset-password';
    // Fragment is read/cleared by the client and sent only in POST JSON: no URL access log token.
    const url = `${this.env.APP_PUBLIC_ORIGIN}/${route}#token=${token}`;
    return tx.nativeAuthToken.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        tokenSha256: nativeTokenHash(input.purpose, token)!,
        deliveryCiphertext: this.box.seal(input.userId, 'MAIL', url),
        credentialRevision: input.credentialRevision,
        expiresAt: new Date(Date.now() + input.ttlMs),
      },
    });
  }

  /** Called only after locking the user; rotating a resend invalidates all earlier link/challenge material. */
  async resend(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const row = await tx.nativeAuthToken.findUniqueOrThrow({ where: { id } });
    const token = randomToken();
    const route = row.purpose === 'ENROLL' ? 'activate' : 'reset-password';
    await tx.nativeAuthToken.update({
      where: { id },
      data: {
        tokenSha256: nativeTokenHash(row.purpose as NativeActionPurpose, token)!,
        deliveryCiphertext: this.box.seal(
          row.userId,
          'MAIL',
          `${this.env.APP_PUBLIC_ORIGIN}/${route}#token=${token}`,
        ),
        revision: { increment: 1 },
        claimedAt: null,
        sentAt: null,
        deliveryAttempts: 0,
        nextDeliveryAt: new Date(),
        deliveryLeaseUntil: null,
      },
    });
  }

  /** Tests can inspect their synthetic delivery, never expose this through an HTTP route. */
  deliveriesForTest(): readonly { to: string; url: string }[] {
    if (this.env.APP_ENV !== 'test' || this.env.AUTH_MAIL_DRIVER !== 'memory')
      throw new Error('Test mail unavailable');
    return this.testMail;
  }

  async deliverPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const rows = await this.prisma.nativeAuthToken.findMany({
        where: {
          usedAt: null,
          revokedAt: null,
          sentAt: null,
          expiresAt: { gt: now },
          deliveryAttempts: { lt: 5 },
          nextDeliveryAt: { lte: now },
          OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lt: now } }],
        },
        take: 10,
        orderBy: { createdAt: 'asc' },
        include: { user: true },
      });
      for (const row of rows) {
        if (!row.deliveryCiphertext || row.user.status !== 'ACTIVE') continue;
        const claimed = await this.prisma.nativeAuthToken.updateMany({
          where: {
            id: row.id,
            revision: row.revision,
            usedAt: null,
            revokedAt: null,
            sentAt: null,
            OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lt: now } }],
          },
          data: {
            deliveryLeaseUntil: new Date(Date.now() + 60_000),
            deliveryAttempts: { increment: 1 },
          },
        });
        if (claimed.count !== 1) continue;
        try {
          const url = this.box.open(row.userId, 'MAIL', row.deliveryCiphertext);
          if (this.smtp) {
            await this.smtp.sendMail({
              from: this.env.AUTH_MAIL_FROM,
              to: { name: '', address: row.user.email },
              subject:
                row.purpose === 'ENROLL'
                  ? 'Nastavení přístupu do AYVO OS'
                  : 'Obnova hesla do AYVO OS',
              text: `Dobrý den,\n\n${row.purpose === 'ENROLL' ? 'Nastavte si heslo a ověřovací aplikaci' : 'Nastavte si nové heslo; druhý faktor zůstává vyžadovaný'} přes tento jednorázový odkaz:\n\n${url}\n\nPokud jste tento požadavek nečekali, kontaktujte správce AYVO a odkaz nikomu nepředávejte.\n`,
              disableFileAccess: true,
              disableUrlAccess: true,
            });
          } else {
            if (this.env.APP_ENV !== 'test') throw new Error('Mail unavailable');
            this.testMail.push({ to: row.user.email, url });
          }
          await this.prisma.nativeAuthToken.updateMany({
            where: { id: row.id, revision: row.revision },
            data: { sentAt: new Date(), deliveryLeaseUntil: null },
          });
        } catch {
          // Do not log SMTP errors: a provider may echo addresses, authentication or message body.
          this.logger.warn('Authentication email delivery failed; queued for retry');
          await this.prisma.nativeAuthToken.updateMany({
            where: { id: row.id, revision: row.revision },
            data: {
              deliveryLeaseUntil: null,
              nextDeliveryAt: new Date(
                Date.now() + Math.min(300_000, 10_000 * 2 ** row.deliveryAttempts),
              ),
            },
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

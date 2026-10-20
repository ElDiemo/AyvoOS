import type {
  CarrierConnection,
  CarrierConnectionAdmin,
  ReplaceCarrierCredentialsRequest,
} from '@ayvo/types';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { accountOf, decryptSecret, encryptSecret, secretDigest } from './credentials-crypto.js';
import {
  isPplConnection,
  PPL_CONNECTIONS,
  serverCredentials,
  type PplConnectionCode,
} from './ppl/ppl-connections.js';

/** Usable credentials of a connection — only inside the server process, never returned. */
export interface ResolvedCredentials {
  code: PplConnectionCode;
  environment: 'TEST' | 'PRODUCTION';
  clientId: string;
  clientSecret: string;
  /** Fingerprint of the account (never the client id). */
  account: string;
  source: 'ADMIN' | 'SERVER';
  /** Changes whenever the credentials are replaced (a new client, a new token). */
  version: string;
}

/** What may be said about a connection's credentials: never their values. */
export interface CredentialState {
  credentials: 'SET' | 'MISSING' | 'UNREADABLE';
  source: 'ADMIN' | 'SERVER' | null;
  account: string | null;
}

/**
 * Credentials of the server-side carrier connections (ADR 0027). Entered in the administration
 * (ADMIN, `carriers:connections_manage`) they are stored only encrypted and take precedence;
 * otherwise the server environment file applies. Stored credentials that cannot be read (another
 * key) are UNREADABLE — never silently replaced by the other source. A secret is never returned,
 * logged, audited or kept in an idempotency record (only a keyed digest).
 */
@Injectable()
export class CarrierCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async resolve(code: string): Promise<ResolvedCredentials | null> {
    if (!isPplConnection(code)) return null;
    const environment = PPL_CONNECTIONS[code].environment;
    const row = await this.prisma.carrierConnection.findUnique({ where: { code } });
    if (row) {
      if (!this.env.CARRIER_CREDENTIALS_KEY) return null;
      const secret = decryptSecret(this.env.CARRIER_CREDENTIALS_KEY, code, row.clientId, {
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        tag: row.secretTag,
        keyId: row.keyId,
      });
      if (secret === null) return null;
      return {
        code,
        environment,
        clientId: row.clientId,
        clientSecret: secret,
        account: row.account,
        source: 'ADMIN',
        version: `admin:${row.updatedAt.toISOString()}`,
      };
    }
    const server = serverCredentials(this.env, code);
    if (!server) return null;
    return {
      code,
      environment,
      ...server,
      account: accountOf('PPL', server.clientId),
      source: 'SERVER',
      version: 'server',
    };
  }

  async state(code: string): Promise<CredentialState> {
    if (!isPplConnection(code)) return { credentials: 'MISSING', source: null, account: null };
    const resolved = await this.resolve(code);
    if (resolved) {
      return { credentials: 'SET', source: resolved.source, account: resolved.account };
    }
    const stored = await this.prisma.carrierConnection.findUnique({
      where: { code },
      select: { code: true },
    });
    return stored
      ? { credentials: 'UNREADABLE', source: 'ADMIN', account: null }
      : { credentials: 'MISSING', source: null, account: null };
  }

  /** The connections a site's settings may choose from (code, environment, set / not set). */
  async connections(): Promise<CarrierConnection[]> {
    return Promise.all(
      (Object.keys(PPL_CONNECTIONS) as PplConnectionCode[]).map(async (code) => {
        const s = await this.state(code);
        return {
          code,
          environment: PPL_CONNECTIONS[code].environment,
          credentials: s.credentials,
          source: s.source,
        };
      }),
    );
  }

  /** Správa systému → Dopravci: the connections, without any credential value. */
  async adminList(): Promise<CarrierConnectionAdmin[]> {
    const rows = await this.prisma.carrierConnection.findMany({
      include: { updater: { select: { displayName: true } } },
    });
    const list = await this.connections();
    return list.map((c) => {
      const row = rows.find((r) => r.code === c.code);
      return {
        ...c,
        carrier: 'PPL',
        keyAvailable: !!this.env.CARRIER_CREDENTIALS_KEY,
        updatedAt: row?.updatedAt.toISOString() ?? null,
        updatedBy: row?.updater.displayName ?? null,
      };
    });
  }

  /**
   * Enters or replaces a connection's credentials (encrypted). The secret is never returned; the
   * idempotency record holds only keyed digests; the audit says what changed, never the values.
   */
  async replace(
    actorId: string,
    code: string,
    input: ReplaceCarrierCredentialsRequest,
  ): Promise<CarrierConnectionAdmin[]> {
    if (!isPplConnection(code)) throw new NotFoundException('Connection not found');
    const key = this.env.CARRIER_CREDENTIALS_KEY;
    if (!key) {
      throw domainError(
        409,
        'CREDENTIALS_KEY_MISSING',
        'The server has no key to store credentials encrypted',
      );
    }
    const account = accountOf('PPL', input.clientId);
    await this.operations.run(
      'CARRIER_CREDENTIALS_REPLACE',
      input.requestId,
      {
        actorId,
        code,
        clientId: secretDigest(key, input.clientId),
        clientSecret: secretDigest(key, input.clientSecret),
        reason: input.reason,
      },
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`carrier_connection:${code}`}))`;
        const before = await tx.carrierConnection.findUnique({
          where: { code },
          select: { account: true },
        });
        const previous = before?.account ?? (await this.resolve(code))?.account ?? null;
        const encrypted = encryptSecret(key, code, input.clientId, input.clientSecret);
        const data = {
          carrier: 'PPL',
          environment: PPL_CONNECTIONS[code].environment,
          clientId: input.clientId,
          account,
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretTag: encrypted.tag,
          keyId: encrypted.keyId,
          updatedAt: new Date(),
          updatedBy: actorId,
        };
        await tx.carrierConnection.upsert({
          where: { code },
          create: { code, ...data },
          update: data,
        });
        await this.audit.record(
          {
            type: 'CARRIER_CREDENTIALS_REPLACED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              connection: code,
              environment: PPL_CONNECTIONS[code].environment,
              // Whether shipments made with the previous account lose this connection.
              accountChanged: previous !== null && previous !== account,
              previousSource: before ? 'ADMIN' : previous ? 'SERVER' : null,
            },
          },
          tx,
        );
        return { code };
      },
    );
    return this.adminList();
  }
}

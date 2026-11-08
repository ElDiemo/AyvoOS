import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ENV, type Env } from '../config/env.js';
import { CustomersModule } from '../customers/customers.module.js';
import type { PrismaService } from '../database/prisma.service.js';
import { IdentityModule } from '../identity/identity.module.js';
import { NativeAuthService } from '../identity/native-auth.service.js';
import { NATIVE_SECRET_BOX, NativeTokensService } from '../identity/native-tokens.service.js';
import { NativePasswords, type NativeSecretBox } from '../identity/native-credentials.js';
import { SessionsService } from '../identity/sessions.service.js';
import { PortalGrantsModule } from '../portal-grants/portal-grants.module.js';
import { PortalContractController } from './portal-contract.controller.js';
import { PortalPrismaService } from './portal-prisma.service.js';
import {
  PORTAL_AUDIT,
  PORTAL_NATIVE_AUTH,
  PORTAL_NATIVE_TOKENS,
  PORTAL_PASSWORDS,
  PORTAL_SESSIONS,
} from './portal-tokens.js';
import { PortalRequestLimit } from './portal-request-limit.js';

/**
 * Link and reset mail of portal accounts: written here (the durable outbox in the database),
 * delivered by the core's one mail worker. This instance never starts a second worker.
 */
export class PortalNativeTokensService extends NativeTokensService implements OnModuleInit {
  override onModuleInit(): void {}
}

// The identity services take the client as `PrismaService`; the portal's is the same Prisma client
// class with its own pool.
const asClient = (db: PortalPrismaService) => db as unknown as PrismaService;

/**
 * The hotel portal contract (ADR 0045 §3, §6, §8). Its sign-in, session and audit services are
 * this module's own instances bound to the portal's reserved pool, so no portal request ever takes
 * a staff connection. They live under the module's own tokens: the identity module's instances
 * (and `PrismaService`) stay the only ones of their classes. Grants and hotels are read through
 * their modules' services with the portal's client.
 */
@Module({
  imports: [IdentityModule, CustomersModule, PortalGrantsModule],
  controllers: [PortalContractController],
  providers: [
    PortalPrismaService,
    PortalRequestLimit,
    {
      provide: PORTAL_AUDIT,
      inject: [PortalPrismaService],
      useFactory: (db: PortalPrismaService) => new AuditService(asClient(db)),
    },
    {
      provide: PORTAL_SESSIONS,
      inject: [PortalPrismaService, ENV],
      useFactory: (db: PortalPrismaService, env: Env) => new SessionsService(asClient(db), env),
    },
    {
      provide: PORTAL_NATIVE_TOKENS,
      inject: [PortalPrismaService, ENV, NATIVE_SECRET_BOX],
      useFactory: (db: PortalPrismaService, env: Env, box: NativeSecretBox) =>
        new PortalNativeTokensService(asClient(db), env, box),
    },
    // The portal's own Argon2 capacity: portal sign-ins never take the internal OS's.
    {
      provide: PORTAL_PASSWORDS,
      inject: [ENV],
      useFactory: (env: Env) => new NativePasswords(env.PORTAL_PASSWORD_CONCURRENCY),
    },
    {
      provide: PORTAL_NATIVE_AUTH,
      inject: [
        PortalPrismaService,
        PORTAL_AUDIT,
        PORTAL_SESSIONS,
        PORTAL_NATIVE_TOKENS,
        PORTAL_PASSWORDS,
        NATIVE_SECRET_BOX,
      ],
      useFactory: (
        db: PortalPrismaService,
        audit: AuditService,
        sessions: SessionsService,
        tokens: NativeTokensService,
        passwords: NativePasswords,
        box: NativeSecretBox,
      ) => new NativeAuthService(asClient(db), audit, sessions, tokens, passwords, box),
    },
  ],
})
export class PortalContractModule {}

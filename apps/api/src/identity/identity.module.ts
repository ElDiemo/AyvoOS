import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from '../config/env.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { AccessGuard } from './access.guard.js';
import { AccessService } from './access.service.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider.js';
import { PrincipalResolver } from './principal-resolver.js';
import { SessionsService } from './sessions.service.js';
import { TestIdentityProvider } from './test.provider.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { WorkOsIdentityProvider } from './workos.provider.js';

/**
 * identity module (Milestone 2C, ADR 0022, doc 021): external OIDC sign-in behind a provider
 * boundary, AYVO users, roles, permissions, scopes, sessions and the security audit. Registers
 * the global access guard — every route of every module is denied unless it declares access.
 */
@Module({
  imports: [InventoryModule],
  controllers: [AuthController, UsersController],
  providers: [
    AuditService,
    AccessService,
    SessionsService,
    PrincipalResolver,
    AuthService,
    UsersService,
    {
      provide: IDENTITY_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): IdentityProvider =>
        env.AUTH_PROVIDER === 'test'
          ? new TestIdentityProvider(env.APP_PUBLIC_ORIGIN)
          : new WorkOsIdentityProvider({
              apiKey: env.WORKOS_API_KEY!,
              clientId: env.WORKOS_CLIENT_ID!,
              apiBaseUrl: env.WORKOS_API_BASE_URL,
              issuer: env.WORKOS_JWT_ISSUER ?? null,
            }),
    },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AccessService, AuditService],
})
export class IdentityModule {}

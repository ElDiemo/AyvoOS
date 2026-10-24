import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from '../config/env.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { SitesModule } from '../sites/sites.module.js';
import { AccessGuard } from './access.guard.js';
import { AccessService } from './access.service.js';
import { AuthController } from './auth.controller.js';
import { AuthRateLimitService } from './auth-rate-limit.service.js';
import { AuthService } from './auth.service.js';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider.js';
import { InvitationsService } from './invitations.service.js';
import { PrincipalResolver } from './principal-resolver.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { SessionsService } from './sessions.service.js';
import { TestIdentityProvider } from './test.provider.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { LocalInvitationsProvider } from './local-invitations.provider.js';
import { NativeAuthController } from './native-auth.controller.js';
import { NativeAuthService } from './native-auth.service.js';
import { NativePasswords, NativeSecretBox } from './native-credentials.js';
import {
  NATIVE_PASSWORDS,
  NATIVE_SECRET_BOX,
  NativeTokensService,
} from './native-tokens.service.js';

/**
 * identity module (Milestone 2C, ADR 0022, doc 021): external OIDC sign-in behind a provider
 * boundary, AYVO users, roles, permissions, scopes, sessions and the security audit. Registers
 * the global access guard — every route of every module is denied unless it declares access.
 */
@Module({
  imports: [InventoryModule, SitesModule],
  controllers: [AuthController, NativeAuthController, UsersController, RolesController],
  providers: [
    AccessService,
    RolesService,
    InvitationsService,
    SessionsService,
    PrincipalResolver,
    AuthService,
    AuthRateLimitService,
    UsersService,
    NativeAuthService,
    NativeTokensService,
    LocalInvitationsProvider,
    { provide: NATIVE_PASSWORDS, useFactory: () => new NativePasswords() },
    {
      provide: NATIVE_SECRET_BOX,
      inject: [ENV],
      useFactory: (env: Env) => new NativeSecretBox(env.AUTH_ENCRYPTION_KEY),
    },
    {
      provide: IDENTITY_PROVIDER,
      inject: [ENV, LocalInvitationsProvider],
      useFactory: (env: Env, local: LocalInvitationsProvider): IdentityProvider =>
        env.AUTH_PROVIDER === 'test' ? new TestIdentityProvider(env.APP_PUBLIC_ORIGIN) : local,
    },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AccessService],
})
export class IdentityModule {}

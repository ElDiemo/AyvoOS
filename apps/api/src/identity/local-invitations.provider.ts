import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { NativeAuthToken, User } from '../generated/prisma/client.js';
import {
  IdentityProviderError,
  type ExternalIdentity,
  type IdentityProvider,
  type ProviderInvitation,
} from './identity-provider.js';
import { NativeTokensService } from './native-tokens.service.js';

/** Adapter for existing invitation administration only. There is no OAuth or external call. */
@Injectable()
export class LocalInvitationsProvider implements IdentityProvider {
  readonly name = 'LOCAL' as const;
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: NativeTokensService,
  ) {}
  authorizationUrl(): string {
    return '/login';
  }
  async exchangeCode(): Promise<ExternalIdentity> {
    throw new IdentityProviderError('External authentication is disabled');
  }
  logoutUrl(): null {
    return null;
  }

  async sendInvitation(input: {
    email: string;
    expiresInDays: number;
  }): Promise<ProviderInvitation> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { email: input.email } });
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { nativeCredential: true },
      });
      if (current.status !== 'ACTIVE' || current.nativeCredential)
        throw new IdentityProviderError('Account is inactive or already activated');
      const existing = await tx.nativeAuthToken.findFirst({
        where: {
          userId: user.id,
          purpose: 'ENROLL',
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      const token =
        existing ??
        (await this.tokens.issue(tx, {
          userId: user.id,
          purpose: 'ENROLL',
          credentialRevision: 0,
          ttlMs: input.expiresInDays * 86_400_000,
        }));
      return this.view(token, current);
    });
  }

  async getInvitation(id: string): Promise<ProviderInvitation> {
    const row = await this.prisma.nativeAuthToken.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!row || row.purpose !== 'ENROLL') throw new IdentityProviderError('No invitation');
    return this.view(row, row.user);
  }

  async findPendingInvitations(email: string): Promise<ProviderInvitation[]> {
    const tokens = await this.prisma.nativeAuthToken.findMany({
      where: {
        user: { email },
        purpose: 'ENROLL',
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map((row) => this.view(row, row.user));
  }

  async resendInvitation(id: string): Promise<ProviderInvitation> {
    const snapshot = await this.prisma.nativeAuthToken.findUniqueOrThrow({ where: { id } });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${snapshot.userId}::uuid FOR UPDATE`;
      const row = await tx.nativeAuthToken.findUniqueOrThrow({
        where: { id },
        include: { user: true },
      });
      if (
        row.usedAt ||
        row.revokedAt ||
        row.expiresAt <= new Date() ||
        row.user.status !== 'ACTIVE'
      )
        return this.view(row, row.user);
      await this.tokens.resend(tx, id);
      return this.view(row, row.user);
    });
  }

  async revokeInvitation(id: string): Promise<ProviderInvitation> {
    const snapshot = await this.prisma.nativeAuthToken.findUniqueOrThrow({ where: { id } });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${snapshot.userId}::uuid FOR UPDATE`;
      let row = await tx.nativeAuthToken.findUniqueOrThrow({
        where: { id },
        include: { user: true },
      });
      if (!row.usedAt && !row.revokedAt)
        row = await tx.nativeAuthToken.update({
          where: { id },
          data: { revokedAt: new Date(), deliveryCiphertext: null },
          include: { user: true },
        });
      return this.view(row, row.user);
    });
  }

  private view(row: NativeAuthToken, user: User): ProviderInvitation {
    return {
      id: row.id,
      email: user.email,
      expiresAt: row.expiresAt,
      state: row.usedAt
        ? 'accepted'
        : row.revokedAt
          ? 'revoked'
          : row.expiresAt <= new Date()
            ? 'expired'
            : 'pending',
      acceptedUserId: row.usedAt ? user.id : null,
    };
  }
}

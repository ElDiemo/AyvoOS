import { Injectable } from '@nestjs/common';
import type { QrIdentityKind } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/**
 * The shared QR identity registry (doc 020 §3.4): one table of every public token and its kind
 * (bottle, crate, workstation), written only by database triggers. Read-only for modules that
 * must tell which kind of object a scanned token names.
 */
@Injectable()
export class QrRegistryService {
  constructor(private readonly prisma: PrismaService) {}

  async kindOf(token: string): Promise<QrIdentityKind | null> {
    const row = await this.prisma.qrIdentity.findUnique({
      where: { token },
      select: { kind: true },
    });
    return row?.kind ?? null;
  }
}

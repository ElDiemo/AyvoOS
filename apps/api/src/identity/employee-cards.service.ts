import { createHash } from 'node:crypto';
import {
  employeeCardFieldsSchema,
  type AdminEmployeeCard,
  type EmployeeCardAction,
  type PublicEmployeeCard,
  type SaveEmployeeCard,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService, type AuditType } from '../audit/audit.service.js';
import { domainError, idempotencyConflict } from '../common/domain-error.js';
import { canonicalJson } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type EmployeeCard } from '../generated/prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { normalizeCardPhoto } from './employee-card-photo.js';
import type { Actor } from './users.service.js';

const missing = () => domainError(404, 'EMPLOYEE_CARD_NOT_FOUND', 'Vizitka není dostupná.');
const conflict = () =>
  domainError(
    409,
    'EMPLOYEE_CARD_STALE',
    'Vizitku mezitím někdo změnil. Načtěte aktuální stav; rozepsané údaje si ponechte.',
  );
const view = (card: EmployeeCard): AdminEmployeeCard => ({
  slug: card.slug,
  version: card.version,
  draft: employeeCardFieldsSchema.parse(card.draft),
  published: card.published === null ? null : employeeCardFieldsSchema.parse(card.published),
  publishedVersion: card.publishedVersion,
  publishedAt: card.publishedAt?.toISOString() ?? null,
});

/** Part of identity: one public projection per employee, never a second employee directory. */
@Injectable()
export class EmployeeCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async get(userId: string) {
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } })))
      throw missing();
    const card = await this.prisma.employeeCard.findUnique({ where: { userId } });
    return { card: card ? view(card) : null };
  }

  private async mutate<R>(
    actor: Actor,
    userId: string,
    requestId: string,
    type: AuditType,
    reason: string,
    input: unknown,
    work: (tx: Prisma.TransactionClient) => Promise<R>,
  ): Promise<R> {
    if (!actor.permissions.has('identity:users_manage'))
      throw domainError(403, 'FORBIDDEN', 'Správa vizitek je jen pro správce uživatelů.');
    const hash = createHash('sha256')
      .update(canonicalJson({ type, input, actor: actor.userId }))
      .digest('hex');
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
        if (!rows.length) throw missing();
        const previous = await tx.auditEvent.findFirst({
          where: {
            targetUserId: userId,
            type: {
              in: [
                'EMPLOYEE_CARD_SAVED',
                'EMPLOYEE_CARD_PUBLISHED',
                'EMPLOYEE_CARD_HIDDEN',
                'EMPLOYEE_CARD_PHOTO_ADDED',
              ],
            },
            payload: { path: ['requestId'], equals: requestId },
          },
        });
        if (previous) {
          const payload = previous.payload as { hash?: string; result?: R };
          if (payload.hash !== hash) throw idempotencyConflict();
          return payload.result as R;
        }
        const result = await work(tx);
        await this.audit.record(
          {
            type,
            actorUserId: actor.userId,
            targetUserId: userId,
            reason,
            payload: {
              requestId,
              hash,
              result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            },
          },
          tx,
        );
        return result;
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
  }

  async save(actor: Actor, userId: string, input: SaveEmployeeCard) {
    try {
      await this.mutate(
        actor,
        userId,
        input.requestId,
        'EMPLOYEE_CARD_SAVED',
        input.reason,
        input,
        async (tx) => {
          const current = await tx.employeeCard.findUnique({ where: { userId } });
          if ((current?.version ?? 0) !== input.expectedVersion) throw conflict();
          if (current && current.slug !== input.slug)
            throw domainError(
              409,
              'EMPLOYEE_CARD_SLUG_FIXED',
              'Adresa z vytištěné vizitky je trvalá a nejde změnit.',
            );
          if (
            input.fields.photoId &&
            !(await tx.employeeCardPhoto.findFirst({ where: { id: input.fields.photoId, userId } }))
          ) {
            throw domainError(
              422,
              'EMPLOYEE_CARD_PHOTO_INVALID',
              'Fotografie nepatří tomuto uživateli.',
            );
          }
          const data = { draft: input.fields, updatedAt: new Date() };
          const saved = current
            ? await tx.employeeCard.update({
                where: { userId },
                data: { ...data, version: { increment: 1 } },
              })
            : await tx.employeeCard.create({ data: { ...data, userId, slug: input.slug } });
          return { card: view(saved) };
        },
      );
      return this.get(userId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw domainError(409, 'EMPLOYEE_CARD_SLUG_USED', 'Tuto adresu již používá jiná vizitka.');
      }
      throw error;
    }
  }

  async publish(actor: Actor, userId: string, input: EmployeeCardAction) {
    await this.mutate(
      actor,
      userId,
      input.requestId,
      'EMPLOYEE_CARD_PUBLISHED',
      input.reason,
      input,
      async (tx) => {
        const current = await tx.employeeCard.findUnique({ where: { userId } });
        if (!current || current.version !== input.expectedVersion) throw conflict();
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { status: true },
        });
        if (user.status !== 'ACTIVE')
          throw domainError(
            409,
            'EMPLOYEE_CARD_USER_INACTIVE',
            'Deaktivovaného zaměstnance nelze zveřejnit.',
          );
        const fields = employeeCardFieldsSchema.parse(current.draft);
        const saved = await tx.employeeCard.update({
          where: { userId },
          data: {
            published: fields,
            publishedVersion: current.version + 1,
            publishedAt: new Date(),
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        return { card: view(saved) };
      },
    );
    return this.get(userId);
  }

  async hide(actor: Actor, userId: string, input: EmployeeCardAction) {
    await this.mutate(
      actor,
      userId,
      input.requestId,
      'EMPLOYEE_CARD_HIDDEN',
      input.reason,
      input,
      async (tx) => {
        const current = await tx.employeeCard.findUnique({ where: { userId } });
        if (!current || current.version !== input.expectedVersion) throw conflict();
        const saved = await tx.employeeCard.update({
          where: { userId },
          data: {
            published: Prisma.DbNull,
            publishedVersion: null,
            publishedAt: null,
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        return { card: view(saved) };
      },
    );
    return this.get(userId);
  }

  async upload(actor: Actor, userId: string, requestId: string, bytes: Buffer) {
    // Size/dimension checks and re-encoding before writing any permanent artifact.
    const normalized = await normalizeCardPhoto(bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return this.mutate(
      actor,
      userId,
      requestId,
      'EMPLOYEE_CARD_PHOTO_ADDED',
      'Nahrání fotografie veřejné vizitky',
      { digest },
      async (tx) => {
        const storageKey = newStorageKey('employee-card-photos', 'png');
        await this.storage.put(storageKey, normalized);
        const photo = await tx.employeeCardPhoto.create({ data: { userId, storageKey } });
        return { id: photo.id };
      },
    );
  }

  async photo(userId: string, photoId: string): Promise<Buffer> {
    const photo = await this.prisma.employeeCardPhoto.findFirst({ where: { id: photoId, userId } });
    if (!photo) throw missing();
    return this.storage.get(photo.storageKey);
  }

  private async publication(slug: string) {
    const card = await this.prisma.employeeCard.findFirst({
      where: { slug, published: { not: Prisma.DbNull }, user: { status: 'ACTIVE' } },
    });
    if (!card || card.published === null || !card.publishedVersion) throw missing();
    return card;
  }

  async publicCard(slug: string): Promise<PublicEmployeeCard> {
    const card = await this.publication(slug);
    const fields = employeeCardFieldsSchema.parse(card.published);
    // Deliberate whitelist, never spread a User or EmployeeCard row into an anonymous response.
    return {
      slug: card.slug,
      version: card.publishedVersion!,
      hasPhoto: fields.photoId !== null,
      name: fields.name,
      role: fields.role,
      company: fields.company,
      tagline: fields.tagline,
      phone: fields.phone,
      email: fields.email,
      website: fields.website,
      linkedin: fields.linkedin,
    };
  }

  async publicPhoto(slug: string, version: number): Promise<Buffer> {
    const card = await this.publication(slug);
    const fields = employeeCardFieldsSchema.parse(card.published);
    if (card.publishedVersion !== version || !fields.photoId) throw missing();
    const bytes = await this.photo(card.userId, fields.photoId);
    // A hide/republication during storage I/O must not serve an old photograph afterwards.
    if ((await this.publication(slug)).publishedVersion !== version) throw missing();
    return bytes;
  }
}

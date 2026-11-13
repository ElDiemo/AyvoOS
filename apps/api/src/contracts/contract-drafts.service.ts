import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CURRENT_CONTRACT_TEMPLATE,
  holdersConsistent,
  hotelIdentityMatches,
  type HotelIdentity,
  type ContractDraftDetail,
  type ContractDraftFields,
  type ContractDraftPrefill,
  type ContractDraftSummary,
  type CreateContractDraftRequest,
  type LinkContractHotelRequest,
  type RemoveContractDraftRequest,
  type ReviseContractDraftRequest,
  type PortalContract,
  type UploadSignedContractFields,
} from '@ayvo/types';
import { CODE_PREFIX, formatCode } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { HotelsService } from '../customers/hotels.service.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { ProspectContextService } from '../sales/prospect-context.service.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { contractDocument, UnknownContractTemplate } from './contract-template.js';
import { InvalidSignedPdf, inspectSignedPdf } from './signed-pdf.js';
import { renderContractPdf } from './contract-pdf.js';

type Db = Prisma.TransactionClient;
type DraftRow = Prisma.ContractDraftGetPayload<object>;
type RevisionRow = Prisma.ContractDraftRevisionGetPayload<object>;

/** Linking a hotel and drafts kept only at a hotel: `sales:manage` + `hotels:read` (ADR 0043 §3). */
export const canUseHotels = (p: Principal) =>
  p.permissions.has('sales:manage') && p.permissions.has('hotels:read');

const notFound = () => new NotFoundException('Contract draft not found');
const concurrentChange = () =>
  domainError(409, 'CONCURRENT_CHANGE', 'Návrh mezitím změnil někdo jiný. Načtěte ho znovu.');
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const safeFilename = (name: string) => {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'podepsano.pdf';
};
const contractUnavailable = () =>
  domainError(503, 'CONTRACT_UNAVAILABLE', 'Smlouvu teď nelze stáhnout. Zkuste to za chvíli.');
const signedLocked = () =>
  domainError(
    409,
    'CONTRACT_DRAFT_SIGNED',
    'Návrh má podepsaný originál: nelze ho odstranit ani změnit vazbu na hotel. Změna = nová revize.',
  );

function assertHolders(f: ContractDraftFields) {
  if (!holdersConsistent(f))
    throw domainError(
      422,
      'HOLDERS_OWNERSHIP_MISMATCH',
      'S držáky zvolte, komu budou patřit; bez držáků se vlastnictví nevyplňuje.',
    );
}

const revisionData = (f: ContractDraftFields) => ({
  templateVersion: CURRENT_CONTRACT_TEMPLATE,
  counterpartyName: f.counterpartyName,
  counterpartyCompanyId: f.counterpartyCompanyId,
  counterpartyAddress: f.counterpartyAddress,
  representativeName: f.representativeName,
  representativeRole: f.representativeRole,
  hotelName: f.hotelName,
  hotelAddress: f.hotelAddress,
  rooms: f.rooms,
  pricePerRoomMonth: f.pricePerRoomMonth,
  currency: f.currency,
  startOn: new Date(`${f.startOn}T00:00:00Z`),
  billingTiming: f.billingTiming,
  paymentTermsDays: f.paymentTermsDays,
  holders: f.holders,
  holdersOwnership: f.holdersOwnership,
});

const fieldsOf = (r: RevisionRow): ContractDraftFields => ({
  counterpartyName: r.counterpartyName,
  counterpartyCompanyId: r.counterpartyCompanyId,
  counterpartyAddress: r.counterpartyAddress,
  representativeName: r.representativeName,
  representativeRole: r.representativeRole,
  hotelName: r.hotelName,
  hotelAddress: r.hotelAddress,
  rooms: r.rooms,
  pricePerRoomMonth: r.pricePerRoomMonth.toFixed(2),
  currency: r.currency,
  startOn: dateOnly(r.startOn),
  billingTiming: r.billingTiming as ContractDraftFields['billingTiming'],
  paymentTermsDays: r.paymentTermsDays,
  holders: r.holders as ContractDraftFields['holders'],
  holdersOwnership: r.holdersOwnership as ContractDraftFields['holdersOwnership'],
});

const address = (h: {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
}) =>
  [h.addressLine1, h.addressLine2, [h.postalCode, h.city].filter(Boolean).join(' ')]
    .filter((x) => x && x.trim() !== '')
    .join(', ') || null;

const hotelIdentity = (h: Parameters<typeof address>[0] & { name: string }): HotelIdentity => ({
  name: h.name,
  address: address(h) ?? '',
});
const draftIdentity = (
  f: Pick<ContractDraftFields, 'hotelName' | 'hotelAddress'>,
): HotelIdentity => ({
  name: f.hotelName,
  address: f.hotelAddress,
});

/**
 * The hotel written in the draft (and its PDF) must be the linked hotel, or the difference is
 * acknowledged explicitly — never saved unobserved (review CD121-1). The refusal names both.
 */
function assertSameHotel(
  draft: HotelIdentity,
  hotel: HotelIdentity & { code: string },
  acknowledged: boolean,
) {
  if (acknowledged || hotelIdentityMatches(draft, hotel)) return;
  throw domainErrorWithDetails(
    409,
    'HOTEL_IDENTITY_MISMATCH',
    'Hotel v návrhu se liší od zvoleného hotelu. Upravte návrh, nebo rozdíl výslovně potvrďte.',
    { draft, hotel },
  );
}

/**
 * Contract drafts (ADR 0043, doc 045): written only by the explicit calls below, each checking
 * access again — the prospect through Obchod's scope, hotels with sales:manage + hotels:read. Out
 * of scope is 404 and never revealed. No hotel is created, nothing in Finance is read or changed,
 * nothing is sent or signed.
 */
@Injectable()
export class ContractDraftsService {
  private readonly logger = new Logger(ContractDraftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly prospects: ProspectContextService,
    private readonly hotels: HotelsService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  // --- access --------------------------------------------------------------------------------

  /** The draft if the caller may see it (its prospect in scope, or a hotel-only draft with the
   * hotel permissions); otherwise 404. */
  private async visible(db: Db, code: string, p: Principal, lock = false): Promise<DraftRow> {
    if (lock)
      await db.$executeRaw`SELECT 1 FROM "contract_drafts" WHERE "code" = ${code} FOR UPDATE`;
    const row = await db.contractDraft.findUnique({ where: { code } });
    if (!row) throw notFound();
    if (row.prospectId) {
      if (!(await this.prospects.visibleById(db, row.prospectId, p))) throw notFound();
    } else if (!canUseHotels(p)) throw notFound();
    return row;
  }

  private async hotelByCode(db: Db, code: string, p: Principal) {
    if (!canUseHotels(p))
      throw domainError(
        403,
        'HOTEL_LINK_FORBIDDEN',
        'K hotelu může návrh připojit jen správce obchodu s přístupem k hotelům.',
      );
    const hotel = await this.hotels.byCode(code, db);
    if (!hotel) throw domainError(422, 'HOTEL_NOT_FOUND', 'Hotel neexistuje.');
    return hotel;
  }

  // --- reads ---------------------------------------------------------------------------------

  /** The context to start from (nothing is written): the prospect's or the hotel's own data. */
  async prefill(
    p: Principal,
    q: { prospect?: string; hotel?: string },
  ): Promise<ContractDraftPrefill> {
    const db = this.prisma;
    const prospect = q.prospect ? await this.prospects.visibleByCode(db, q.prospect, p) : null;
    const hotel = q.hotel ? await this.hotelByCode(db, q.hotel, p) : null;
    const hotels = canUseHotels(p)
      ? (await this.hotels.identities()).map((h) => ({
          code: h.code,
          ...hotelIdentity(h),
        }))
      : [];
    return {
      prospect: prospect && { code: prospect.code, name: prospect.name },
      hotel: hotel && { code: hotel.code, name: hotel.name },
      fields: {
        counterpartyName: null,
        hotelName: hotel?.name ?? prospect?.name ?? null,
        hotelAddress: hotel ? address(hotel) : prospect ? address(prospect) : null,
        rooms: prospect?.roomsEstimate ?? null,
      },
      hotels,
    };
  }

  /** The drafts of one prospect (in scope) or of one hotel (sales:manage + hotels:read). */
  async list(
    p: Principal,
    q: { prospect?: string; hotel?: string },
  ): Promise<ContractDraftSummary[]> {
    const db = this.prisma;
    let where: Prisma.ContractDraftWhereInput;
    if (q.prospect) {
      const prospect = await this.prospects.visibleByCode(db, q.prospect, p);
      where = { prospectId: prospect.id };
    } else if (q.hotel) {
      const hotel = await this.hotelByCode(db, q.hotel, p);
      where = { hotelId: hotel.id };
    } else throw domainError(400, 'CONTEXT_REQUIRED', 'Zvolte akvizici nebo hotel.');
    const rows = await db.contractDraft.findMany({ where, orderBy: { serial: 'desc' } });
    return Promise.all(rows.map((r) => this.summary(db, r, p)));
  }

  async detail(code: string, p: Principal): Promise<ContractDraftDetail> {
    const db = this.prisma;
    const row = await this.visible(db, code, p);
    const linked = row.hotelId && canUseHotels(p) ? await this.hotels.byId(row.hotelId, db) : null;
    const [revisions, events, signed] = await Promise.all([
      db.contractDraftRevision.findMany({
        where: { draftId: row.id },
        orderBy: { revision: 'desc' },
        include: { creator: { select: { displayName: true } } },
      }),
      db.contractDraftEvent.findMany({
        where: { draftId: row.id },
        orderBy: { at: 'desc' },
        include: { actor: { select: { displayName: true } } },
      }),
      db.contractSignedDocument.findMany({
        where: { draftId: row.id },
        orderBy: { revision: 'desc' },
        include: { uploader: { select: { displayName: true } } },
      }),
    ]);
    return {
      ...(await this.summary(db, row, p)),
      removedAt: row.removedAt?.toISOString() ?? null,
      removeReason: row.removeReason,
      revisions: revisions.map((r) => ({
        revision: r.revision,
        templateVersion: r.templateVersion as typeof CURRENT_CONTRACT_TEMPLATE,
        fields: fieldsOf(r),
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        createdByName: r.creator.displayName,
      })),
      events: events.map((e) => ({
        kind: e.kind as ContractDraftDetail['events'][number]['kind'],
        revision: e.revision,
        at: e.at.toISOString(),
        actorName: e.actor.displayName,
        reason: e.reason,
      })),
      // After signing only the first link (to the hotel the signed revision names).
      canLinkHotel:
        canUseHotels(p) && row.removedAt === null && (signed.length === 0 || row.hotelId === null),
      signedHotel:
        signed.length > 0
          ? draftIdentity(fieldsOf(revisions.find((r) => r.revision === signed[0]!.revision)!))
          : null,
      hotelIdentity: linked && hotelIdentity(linked),
      signed: signed.map((x) => ({
        revision: x.revision,
        signedOn: dateOnly(x.signedOn),
        originalFilename: x.originalFilename,
        byteSize: x.byteSize,
        sha256: x.sha256,
        uploadedAt: x.uploadedAt.toISOString(),
        uploadedByName: x.uploader.displayName,
      })),
      canUploadSigned:
        row.removedAt === null && !signed.some((x) => x.revision === row.currentRevision),
      hotelMismatch:
        !!linked &&
        !hotelIdentityMatches(draftIdentity(fieldsOf(revisions[0]!)), hotelIdentity(linked)),
    };
  }

  private async summary(db: Db, row: DraftRow, p: Principal): Promise<ContractDraftSummary> {
    const current = await db.contractDraftRevision.findUniqueOrThrow({
      where: { draftId_revision: { draftId: row.id, revision: row.currentRevision } },
    });
    const prospect = row.prospectId
      ? await this.prospects.visibleById(db, row.prospectId, p)
      : null;
    // The hotel is named only to those who may see hotels.
    const hotel = row.hotelId && canUseHotels(p) ? await this.hotels.byId(row.hotelId, db) : null;
    return {
      code: row.code,
      version: row.version,
      currentRevision: row.currentRevision,
      counterpartyName: current.counterpartyName,
      hotelName: current.hotelName,
      prospect: prospect && { code: prospect.code, name: prospect.name },
      hotel: hotel && { code: hotel.code, name: hotel.name },
      removed: row.removedAt !== null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // --- writes --------------------------------------------------------------------------------

  async create(req: CreateContractDraftRequest, p: Principal): Promise<ContractDraftDetail> {
    assertHolders(req.fields);
    const { result } = await this.operations.run(
      'CONTRACT_DRAFT_CREATE',
      req.requestId,
      { ...req, actorId: p.userId },
      async (tx) => {
        const prospect = req.prospectCode
          ? await this.prospects.visibleByCode(tx, req.prospectCode, p, true)
          : null;
        if (prospect) this.prospects.assertActive(prospect);
        const hotel = req.hotelCode ? await this.hotelByCode(tx, req.hotelCode, p) : null;
        if (hotel)
          assertSameHotel(
            draftIdentity(req.fields),
            { code: hotel.code, ...hotelIdentity(hotel) },
            req.acknowledgeHotelMismatch,
          );
        const { first } = await allocateSerials(tx, 'contract_draft', 1);
        const draft = await tx.contractDraft.create({
          data: {
            serial: first,
            code: formatCode(CODE_PREFIX.contractDraft, first),
            prospectId: prospect?.id ?? null,
            hotelId: hotel?.id ?? null,
            createdBy: p.userId,
            updatedBy: p.userId,
          },
        });
        await tx.contractDraftRevision.create({
          data: {
            draftId: draft.id,
            revision: 1,
            ...revisionData(req.fields),
            reason: null,
            createdBy: p.userId,
            requestId: req.requestId,
          },
        });
        await tx.contractDraftEvent.create({
          data: {
            draftId: draft.id,
            kind: 'CREATED',
            revision: 1,
            actorId: p.userId,
            details: { prospect: prospect?.code ?? null, hotel: hotel?.code ?? null },
          },
        });
        return { code: draft.code };
      },
    );
    return this.detail(result.code, p);
  }

  async revise(
    code: string,
    req: ReviseContractDraftRequest,
    p: Principal,
  ): Promise<ContractDraftDetail> {
    assertHolders(req.fields);
    await this.operations.run(
      'CONTRACT_DRAFT_REVISE',
      req.requestId,
      { code, ...req, actorId: p.userId },
      async (tx) => {
        const row = await this.writable(tx, code, req.expectedVersion, p);
        if (row.hotelId) {
          const linked = (await this.hotels.byId(row.hotelId, tx))!;
          assertSameHotel(
            draftIdentity(req.fields),
            { code: linked.code, ...hotelIdentity(linked) },
            req.acknowledgeHotelMismatch,
          );
        }
        const revision = row.currentRevision + 1;
        await tx.contractDraftRevision.create({
          data: {
            draftId: row.id,
            revision,
            ...revisionData(req.fields),
            reason: req.reason,
            createdBy: p.userId,
            requestId: req.requestId,
          },
        });
        await this.next(tx, row, p, { currentRevision: revision });
        await tx.contractDraftEvent.create({
          data: {
            draftId: row.id,
            kind: 'REVISED',
            revision,
            actorId: p.userId,
            reason: req.reason,
          },
        });
        return { revision };
      },
    );
    return this.detail(code, p);
  }

  /** Removed by hand, confirmed, with a reason — restorable; never deleted. */
  async remove(
    code: string,
    req: RemoveContractDraftRequest,
    p: Principal,
  ): Promise<ContractDraftDetail> {
    await this.operations.run(
      'CONTRACT_DRAFT_REMOVE',
      req.requestId,
      { code, ...req, actorId: p.userId },
      async (tx) => {
        const row = await this.writable(tx, code, req.expectedVersion, p);
        if (await tx.contractSignedDocument.count({ where: { draftId: row.id } }))
          throw signedLocked();
        await this.next(tx, row, p, {
          removedAt: new Date(),
          removedBy: p.userId,
          removeReason: req.reason,
        });
        await tx.contractDraftEvent.create({
          data: { draftId: row.id, kind: 'REMOVED', actorId: p.userId, reason: req.reason },
        });
        return { removed: true };
      },
    );
    return this.detail(code, p);
  }

  async restore(
    code: string,
    req: RemoveContractDraftRequest,
    p: Principal,
  ): Promise<ContractDraftDetail> {
    await this.operations.run(
      'CONTRACT_DRAFT_RESTORE',
      req.requestId,
      { code, ...req, actorId: p.userId },
      async (tx) => {
        const row = await this.visible(tx, code, p, true);
        if (row.version !== req.expectedVersion) throw concurrentChange();
        if (!row.removedAt)
          throw domainError(409, 'CONTRACT_DRAFT_NOT_REMOVED', 'Návrh není odstraněný.');
        await this.next(tx, row, p, { removedAt: null, removedBy: null, removeReason: null });
        await tx.contractDraftEvent.create({
          data: { draftId: row.id, kind: 'RESTORED', actorId: p.userId, reason: req.reason },
        });
        return { restored: true };
      },
    );
    return this.detail(code, p);
  }

  /**
   * Links an existing hotel by hand, or corrects a wrong link of an unsigned draft (a new event
   * with the reason, from → to); never creates or unlinks a hotel. The hotel must be the one the
   * draft names, or the difference is acknowledged (review CD121-1).
   */
  async linkHotel(
    code: string,
    req: LinkContractHotelRequest,
    p: Principal,
  ): Promise<ContractDraftDetail> {
    await this.operations.run(
      'CONTRACT_DRAFT_HOTEL',
      req.requestId,
      { code, ...req, actorId: p.userId },
      async (tx) => {
        const row = await this.writable(tx, code, req.expectedVersion, p);
        const hotel = await this.hotelByCode(tx, req.hotelCode, p);
        if (row.hotelId === hotel.id)
          throw domainError(409, 'HOTEL_ALREADY_LINKED', 'Návrh už k tomuto hotelu připojený je.');
        const current = await tx.contractDraftRevision.findUniqueOrThrow({
          where: { draftId_revision: { draftId: row.id, revision: row.currentRevision } },
        });
        const signed = await tx.contractSignedDocument.findMany({
          where: { draftId: row.id },
          include: { revisionRow: true },
        });
        if (signed.length > 0) {
          // Signed: the existing link never changes; the FIRST link only to the hotel every signed
          // revision names exactly — no acknowledgement overrides it (review SIGN122-R2).
          if (row.hotelId) throw signedLocked();
          for (const x of signed) {
            const named = draftIdentity(x.revisionRow);
            if (!hotelIdentityMatches(named, hotelIdentity(hotel)))
              throw domainErrorWithDetails(
                409,
                'HOTEL_NOT_SIGNED_HOTEL',
                'Podepsaná revize uvádí jiný hotel. Podepsaný návrh lze připojit jen k hotelu, který uvádí.',
                {
                  signedRevision: x.revision,
                  draft: named,
                  hotel: { code: hotel.code, ...hotelIdentity(hotel) },
                },
              );
          }
        } else {
          assertSameHotel(
            draftIdentity(current),
            { code: hotel.code, ...hotelIdentity(hotel) },
            req.acknowledgeMismatch,
          );
        }
        const previous = row.hotelId ? await this.hotels.byId(row.hotelId, tx) : null;
        await this.next(tx, row, p, { hotelId: hotel.id });
        await tx.contractDraftEvent.create({
          data: {
            draftId: row.id,
            kind: 'HOTEL_LINKED',
            actorId: p.userId,
            reason: req.reason,
            details: {
              from: previous?.code ?? null,
              to: hotel.code,
              signedRevisions: signed.map((x) => x.revision),
              mismatchAcknowledged: !hotelIdentityMatches(
                draftIdentity(current),
                hotelIdentity(hotel),
              ),
            },
          },
        });
        return { hotel: hotel.code };
      },
    );
    return this.detail(code, p);
  }

  /** The PDF of one revision, rendered from that revision only; the download is recorded. */
  async pdf(code: string, revision: number, p: Principal): Promise<{ file: Buffer; name: string }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.visible(tx, code, p);
      const r = await tx.contractDraftRevision.findUnique({
        where: { draftId_revision: { draftId: row.id, revision } },
      });
      if (!r) throw notFound();
      // Printed with the template version this revision was saved with (review CD121-2).
      let document;
      try {
        document = contractDocument(r.templateVersion, {
          code,
          revision,
          savedOn: dateOnly(r.createdAt),
          fields: fieldsOf(r),
        });
      } catch (e) {
        if (e instanceof UnknownContractTemplate)
          throw domainError(
            409,
            'CONTRACT_TEMPLATE_UNKNOWN',
            'Tato revize byla uložena s verzí šablony, kterou tato verze aplikace nezná.',
          );
        throw e;
      }
      const file = await renderContractPdf(document);
      await tx.contractDraftEvent.create({
        data: { draftId: row.id, kind: 'PDF_DOWNLOADED', revision, actorId: p.userId },
      });
      return { file, name: `${code}-r${revision}-NAVRH.pdf` };
    });
  }

  /**
   * The already signed original of the CURRENT revision, uploaded by hand (doc 045 §7). Like every
   * write it locks the draft row first and names the version seen, so it serialises with editing,
   * removal and hotel links: whichever commits first wins, the other gets CONCURRENT_CHANGE — a
   * paper signed for revision r is never filed under r+1. The file is written after the request
   * row (a replay never stores a second file) and before the record: a failure in between leaves
   * an unreferenced file (logged), never a record without its file. Recognised as PDF by content.
   */
  async uploadSigned(
    code: string,
    fields: UploadSignedContractFields,
    file: { buffer: Buffer; originalname: string },
    p: Principal,
  ): Promise<ContractDraftDetail> {
    // A real, complete PDF with a page (review SIGN122-R1); the bytes are kept as uploaded.
    try {
      await inspectSignedPdf(file.buffer);
    } catch (e) {
      if (!(e instanceof InvalidSignedPdf)) throw e;
      throw domainError(
        422,
        'UNSUPPORTED_DOCUMENT',
        'Soubor není úplné PDF s alespoň jednou stránkou. Nahrajte podepsaný originál jako PDF.',
      );
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    await this.operations.run(
      'CONTRACT_SIGNED_UPLOAD',
      fields.requestId,
      { code, ...fields, sha256, actorId: p.userId },
      async (tx) => {
        const row = await this.writable(tx, code, fields.expectedVersion, p);
        if (fields.revision !== row.currentRevision) throw concurrentChange();
        if (
          await tx.contractSignedDocument.count({
            where: { draftId: row.id, revision: row.currentRevision },
          })
        )
          throw domainError(
            409,
            'CONTRACT_REVISION_SIGNED',
            'Tato revize už podepsaný originál má; nelze ho nahradit.',
          );
        // The linked hotel must be exactly the one the revision being signed names — checked here,
        // under the lock and before any file is written; an acknowledgement given while it was a
        // draft never carries over (review SIGN122-R3). Without hotels:read nothing of the hotel
        // record is revealed: the way out goes through the sales administrator.
        if (row.hotelId) {
          const signing = await tx.contractDraftRevision.findUniqueOrThrow({
            where: { draftId_revision: { draftId: row.id, revision: row.currentRevision } },
          });
          const linked = (await this.hotels.byId(row.hotelId, tx))!;
          if (!hotelIdentityMatches(draftIdentity(signing), hotelIdentity(linked)))
            throw canUseHotels(p)
              ? domainErrorWithDetails(
                  409,
                  'HOTEL_NOT_SIGNED_REVISION',
                  'Připojený hotel neodpovídá hotelu v podepisované revizi. Opravte vazbu, nebo upravte návrh; originál se neuložil.',
                  {
                    revision: signing.revision,
                    draft: draftIdentity(signing),
                    hotel: { code: linked.code, ...hotelIdentity(linked) },
                  },
                )
              : domainError(
                  409,
                  'HOTEL_NOT_SIGNED_REVISION',
                  'Připojený hotel neodpovídá hotelu v podepisované revizi. Požádejte správce obchodu o opravu vazby; originál se neuložil.',
                );
        }
        const storageKey = newStorageKey('contract-documents', 'pdf');
        await this.storage.put(storageKey, file.buffer);
        try {
          await tx.contractSignedDocument.create({
            data: {
              draftId: row.id,
              revision: row.currentRevision,
              storageKey,
              sha256,
              byteSize: file.buffer.length,
              originalFilename: safeFilename(file.originalname),
              signedOn: new Date(`${fields.signedOn}T00:00:00Z`),
              uploadedBy: p.userId,
              requestId: fields.requestId,
            },
          });
        } catch (error) {
          this.logger.warn(`Unreferenced signed contract file after failed insert: ${storageKey}`);
          throw error;
        }
        await this.next(tx, row, p, {});
        await tx.contractDraftEvent.create({
          data: {
            draftId: row.id,
            kind: 'SIGNED_UPLOADED',
            revision: row.currentRevision,
            actorId: p.userId,
            details: { sha256, byteSize: file.buffer.length, signedOn: fields.signedOn },
          },
        });
        return { revision: row.currentRevision };
      },
    );
    return this.detail(code, p);
  }

  /** The signed original as kept (its hash checked), with the same access check; recorded. */
  async signedFile(
    code: string,
    revision: number,
    p: Principal,
  ): Promise<{ file: Buffer; name: string }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.visible(tx, code, p);
      const doc = await tx.contractSignedDocument.findUnique({
        where: { draftId_revision: { draftId: row.id, revision } },
      });
      if (!doc) throw notFound();
      const file = await this.storage.get(doc.storageKey);
      if (createHash('sha256').update(file).digest('hex') !== doc.sha256)
        throw domainError(500, 'STORED_FILE_CHANGED', 'Uložený originál neodpovídá svému otisku.');
      await tx.contractDraftEvent.create({
        data: { draftId: row.id, kind: 'SIGNED_DOWNLOADED', revision, actorId: p.userId },
      });
      return { file, name: `${code}-r${revision}-PODEPSANO.pdf` };
    });
  }

  // --- the hotel portal (ADR 0045; doc 055): signed originals only -------------------------

  /**
   * The signed originals of drafts linked to this hotel, newest first, through the caller's client
   * (the portal's pool). Only what AYVO uploaded as signed: drafts, their revisions and the
   * working template are never offered. A signed draft keeps its hotel for good (DB).
   */
  async portalSigned(hotelId: string, db: Db = this.prisma): Promise<PortalContract[]> {
    const rows = await db.contractSignedDocument.findMany({
      where: { revisionRow: { draft: { hotelId } } },
      select: {
        id: true,
        signedOn: true,
        byteSize: true,
        revisionRow: { select: { startOn: true } },
      },
      orderBy: [{ signedOn: 'desc' }, { uploadedAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      signedOn: r.signedOn.toISOString().slice(0, 10),
      startOn: r.revisionRow.startOn.toISOString().slice(0, 10),
      byteSize: r.byteSize,
    }));
  }

  /**
   * One signed original for a portal account, if its draft's hotel is one of `hotelIds` (the
   * session's granted hotels, evaluated by the caller now); any other id is "not found". The file
   * is returned as kept, its hash checked, and the download recorded on the draft with the portal
   * account as actor.
   */
  async portalSignedFile(
    documentId: string,
    hotelIds: ReadonlySet<string>,
    actorUserId: string,
    read: { signal: AbortSignal; maxBytes: number },
    db: Db = this.prisma,
  ): Promise<{ file: Buffer; signedOn: string }> {
    const doc = await db.contractSignedDocument.findUnique({
      where: { id: documentId },
      include: { revisionRow: { select: { draft: { select: { id: true, hotelId: true } } } } },
    });
    const hotelId = doc?.revisionRow.draft.hotelId;
    if (!doc || !hotelId || !hotelIds.has(hotelId))
      throw domainError(404, 'CONTRACT_NOT_FOUND', 'No such contract');
    // Bounded real work (review 5841786998): the request's deadline or the client leaving stops the
    // read in the storage itself, at most the upload limit is ever read, and the read settles only
    // once the storage resource is released. Any failure → 503, nothing recorded or sent.
    let file: Buffer;
    try {
      file = await this.storage.getBounded(doc.storageKey, read);
    } catch (error) {
      this.logger.warn(`Portal contract PDF not read: ${(error as Error).name}`);
      throw contractUnavailable();
    }
    if (read.signal.aborted) throw contractUnavailable();
    if (createHash('sha256').update(file).digest('hex') !== doc.sha256)
      throw domainError(500, 'STORED_FILE_CHANGED', 'Uložený originál neodpovídá svému otisku.');
    await db.contractDraftEvent.create({
      data: {
        draftId: doc.revisionRow.draft.id,
        kind: 'SIGNED_DOWNLOADED',
        revision: doc.revision,
        actorId: actorUserId,
        details: { via: 'PORTAL' },
      },
    });
    return { file, signedOn: doc.signedOn.toISOString().slice(0, 10) };
  }

  // --- helpers -------------------------------------------------------------------------------

  private async writable(tx: Db, code: string, expectedVersion: number, p: Principal) {
    const row = await this.visible(tx, code, p, true);
    if (row.version !== expectedVersion) throw concurrentChange();
    if (row.removedAt)
      throw domainError(409, 'CONTRACT_DRAFT_REMOVED', 'Návrh je odstraněný; nejdřív ho obnovte.');
    if (row.prospectId) {
      const prospect = await this.prospects.visibleById(tx, row.prospectId, p);
      if (prospect) this.prospects.assertActive(prospect);
    }
    return row;
  }

  private next(
    tx: Db,
    row: DraftRow,
    p: Principal,
    data: Prisma.ContractDraftUncheckedUpdateInput,
  ) {
    return tx.contractDraft.update({
      where: { id: row.id },
      data: { ...data, version: row.version + 1, updatedAt: new Date(), updatedBy: p.userId },
    });
  }
}

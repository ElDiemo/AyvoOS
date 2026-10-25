import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  FINANCE_EXPORT_REQUIRED,
  type AccountingExport,
  type AccountingExportChange,
  type AccountingExportDetail,
  type AccountingExportEvent,
  type AccountingExportLine,
  type AccountingExportMode,
  type AccountingExportPreview,
  type AccountingExportPreviewQuery,
  type CreateAccountingExportRequest,
  type FinanceDocumentKind,
  type FinanceDocumentSource,
  type HandOverAccountingExportRequest,
} from '@ayvo/types';
import { domainError, idempotencyConflict } from '../common/domain-error.js';
import { canonicalJson, payloadHash } from '../database/operation-requests.service.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { CoreClient } from './core-client.js';
import { csvFile } from './csv.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FinanceDocumentsService, missingForExport } from './finance-documents.service.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';
import { buildZip } from './zip.js';

/**
 * Bounds of one export (doc 039 §7, ADR 0039 §5). The archive is built in memory, outside any
 * database transaction: at most the originals (≤ bytes) plus one archive copy of about the same
 * size are held at once — about 2 × 100 MiB, inside the unit's 512 MiB container limit. One build
 * per process at a time.
 */
export const EXPORT_LIMITS = { documents: 1000, bytes: 100 * 1024 * 1024 };
/** Serialises the final step of export creation: two exports never hand over the same change twice. */
const EXPORT_LOCK = 0x41_59_56_4f_45_58; // "AYVOEX"

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const month = (d: Date) => d.toISOString().slice(0, 7);
const monthDate = (m: string) => new Date(`${m}-01T00:00:00Z`);

type Tx = Prisma.TransactionClient | FinancePrismaService;
type Snapshot = Record<string, string | null>;
type DocumentRow = Prisma.DocumentGetPayload<object>;

interface Candidate {
  doc: DocumentRow;
  change: AccountingExportChange;
  snapshot: Snapshot;
  line: AccountingExportLine;
  /** Voided documents are listed without their file. */
  withFile: boolean;
}

interface Plan {
  candidates: Candidate[];
  incomplete: { code: string; missing: (typeof FINANCE_EXPORT_REQUIRED)[number][] }[];
  unassigned: number;
  fingerprint: string;
}

/**
 * Finance — the monthly export for the accountant (doc 039 §7, N2) in the Finance unit. For one
 * handover month: a preview with a fingerprint; the confirmation must present that fingerprint
 * (otherwise 409 PREVIEW_STALE — a new preview is needed); a ZIP with a CSV manifest and the
 * unchanged originals, recorded per document version and file hash. FULL = every complete valid
 * document of the month; SUPPLEMENT = only what is new, changed or voided since the earlier
 * exports of that month. Generated, downloaded and handed over to the accountant are separate
 * append-only events; nothing implies posting or payment.
 */
@Injectable()
export class AccountingExportsService {
  private readonly logger = new Logger(AccountingExportsService.name);
  /** The export being built in this process (one at a time — ADR 0039 §5). */
  private building: {
    requestId: string;
    /** The complete request being built (payload hash incl. the author) — review FIN68-R1. */
    hash: string;
    done: Promise<AccountingExportDetail>;
  } | null = null;

  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
    private readonly documents: FinanceDocumentsService,
    private readonly core: CoreClient,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async preview(query: AccountingExportPreviewQuery): Promise<AccountingExportPreview> {
    const plan = await this.plan(this.prisma, query.handoverMonth, query.mode);
    const totalBytes = bytesOf(plan.candidates);
    return {
      handoverMonth: query.handoverMonth,
      mode: query.mode,
      lines: plan.candidates.map((c) => c.line),
      totals: totals(plan.candidates),
      incomplete: plan.incomplete,
      unassigned: plan.unassigned,
      totalBytes,
      tooLarge: tooLarge(plan.candidates.length, totalBytes),
      limits: { ...EXPORT_LIMITS },
      fingerprint: plan.fingerprint,
    };
  }

  /**
   * Creates the export the person confirmed. Idempotent per requestId over the complete request
   * (month, mode, fingerprint, note, author): a replay returns the same export; anything else
   * under the id is a conflict — also while the first request is still being built; the very same
   * request arriving meanwhile waits for that build. Another export while one is being built: 409
   * EXPORT_BUSY (no queue).
   */
  async create(
    input: CreateAccountingExportRequest,
    caller: FinanceCaller,
  ): Promise<AccountingExportDetail> {
    const payload = {
      handoverMonth: input.handoverMonth,
      mode: input.mode,
      previewFingerprint: input.previewFingerprint,
      note: input.note ?? null,
      actorId: caller.principal.userId,
    };
    const hash = payloadHash('ACCOUNTING_EXPORT_CREATE', payload);
    // Before and after the replay lookup: a build of this request may be in flight.
    const inFlight = this.inFlight(input.requestId, hash);
    if (inFlight) return inFlight;
    const replay = await this.replayed('ACCOUNTING_EXPORT_CREATE', input.requestId, payload);
    if (replay) return this.detail(replay);
    const started = this.inFlight(input.requestId, hash);
    if (started) return started;
    if (this.building)
      throw domainError(409, 'EXPORT_BUSY', 'Právě se vytváří jiný export. Zkuste to za chvíli.');
    const done = this.build(input, payload, caller).finally(() => {
      this.building = null;
    });
    this.building = { requestId: input.requestId, hash, done };
    return done;
  }

  /**
   * The build of this requestId in progress: shared only with the very same request (payload and
   * author — review FIN68-R1); the same id with anything else is IDEMPOTENCY_CONFLICT.
   */
  private inFlight(requestId: string, hash: string): Promise<AccountingExportDetail> | null {
    if (!this.building || this.building.requestId !== requestId) return null;
    if (this.building.hash !== hash) throw idempotencyConflict();
    return this.building.done;
  }

  private async build(
    input: CreateAccountingExportRequest,
    payload: object,
    caller: FinanceCaller,
  ): Promise<AccountingExportDetail> {
    // 1. What the person saw is still what would be exported; complete; within the bounds —
    //    all decided on the declared sizes BEFORE any file is loaded.
    const plan = await this.plan(this.prisma, input.handoverMonth, input.mode);
    if (plan.fingerprint !== input.previewFingerprint) throw previewStale();
    if (plan.incomplete.length > 0)
      throw domainError(
        422,
        'INCOMPLETE_DOCUMENTS',
        `Doklady měsíce je třeba doplnit: ${plan.incomplete.map((i) => i.code).join(', ')}.`,
      );
    if (plan.candidates.length === 0)
      throw domainError(422, 'NOTHING_TO_EXPORT', 'V měsíci není nic k předání.');
    if (tooLarge(plan.candidates.length, bytesOf(plan.candidates))) throw exportTooLarge();

    // 2. The originals and the archive, outside any transaction, counting the real bytes.
    const files: { name: string; data: Buffer; candidate: Candidate }[] = [];
    let loaded = 0;
    for (const c of plan.candidates.filter((x) => x.withFile)) {
      const data = await this.documents.original(c.doc, caller); // hash-checked
      loaded += data.length;
      if (loaded > EXPORT_LIMITS.bytes) throw exportTooLarge();
      files.push({ name: `doklady/${c.doc.code}-${c.doc.originalFilename}`, data, candidate: c });
    }
    const suppliers = await this.core.lookupSuppliers(
      caller.sessionToken,
      plan.candidates.map((c) => c.snapshot.supplierId).filter((v): v is string => !!v),
    );
    const zip = archive(input.handoverMonth, input.mode, plan.candidates, files, suppliers);
    const storageKey = newStorageKey('accounting-exports', 'zip');
    await this.storage.put(storageKey, zip);

    // 3. A short final transaction: lock, the same content once more, record.
    try {
      const { result } = await this.operations.run(
        'ACCOUNTING_EXPORT_CREATE',
        input.requestId,
        payload,
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EXPORT_LOCK}::bigint)`;
          const now = await this.plan(tx, input.handoverMonth, input.mode, true);
          if (now.fingerprint !== input.previewFingerprint) throw previewStale();
          const serial = await allocateFinanceSerial(tx, 'accounting_export');
          const code = `AE-${String(serial).padStart(6, '0')}`;
          const record = await tx.export.create({
            data: {
              serial,
              code,
              handoverMonth: monthDate(input.handoverMonth),
              mode: input.mode,
              note: input.note ?? null,
              previewFingerprint: input.previewFingerprint,
              documentCount: now.candidates.length,
              storageKey,
              sha256: createHash('sha256').update(zip).digest('hex'),
              byteSize: zip.length,
              createdBy: caller.principal.userId,
              createdByName: caller.principal.displayName,
              requestId: input.requestId,
            },
          });
          await tx.exportItem.createMany({
            data: now.candidates.map((c) => ({
              exportId: record.id,
              documentId: c.doc.id,
              documentVersion: c.doc.version,
              change: c.change,
              sha256: c.doc.sha256,
            })),
          });
          await tx.exportEvent.create({
            data: {
              exportId: record.id,
              type: 'GENERATED',
              actorId: caller.principal.userId,
              actorName: caller.principal.displayName,
            },
          });
          return { code };
        },
      );
      return this.detail(result.code);
    } catch (error) {
      this.logger.warn(`Unreferenced accounting export file after a failed export: ${storageKey}`);
      throw error;
    }
  }

  async list(): Promise<AccountingExport[]> {
    const rows = await this.prisma.export.findMany({
      include: { events: true },
      orderBy: { serial: 'desc' },
      take: 200,
    });
    return rows.map(toDto);
  }

  async detail(code: string): Promise<AccountingExportDetail> {
    const record = await this.prisma.export.findUnique({
      where: { code },
      include: {
        events: { orderBy: { occurredAt: 'asc' } },
        items: { include: { document: true, event: { select: { snapshot: true } } } },
      },
    });
    if (!record) throw new NotFoundException('Export nenalezen');
    const lines = record.items
      .map((i) =>
        lineOf(
          i.document,
          i.event.snapshot as Snapshot,
          i.documentVersion,
          i.change as AccountingExportChange,
        ),
      )
      .sort(byIssueDate);
    return {
      ...toDto(record),
      lines,
      events: record.events.map((e): AccountingExportEvent => ({
        type: e.type as AccountingExportEvent['type'],
        handedOverOn: day(e.handedOverOn),
        note: e.note,
        actor: e.actorName,
        occurredAt: e.occurredAt.toISOString(),
      })),
      laterChanges: await this.laterChanges(record),
    };
  }

  /** The stored package, exactly as created; every download is recorded (it is not a handover). */
  async content(code: string, caller: FinanceCaller) {
    const record = await this.prisma.export.findUnique({ where: { code } });
    if (!record) throw new NotFoundException('Export nenalezen');
    const bytes = await this.storage.get(record.storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
      throw domainError(500, 'STORED_FILE_CHANGED', `Uložený export ${code} nesouhlasí.`);
    await this.prisma.exportEvent.create({
      data: {
        exportId: record.id,
        type: 'DOWNLOADED',
        actorId: caller.principal.userId,
        actorName: caller.principal.displayName,
      },
    });
    return { bytes, filename: `${record.code}_${month(record.handoverMonth)}.zip` };
  }

  /** "Předáno účetní": recorded by hand, once, with the day and a note; idempotent per request. */
  async handOver(
    code: string,
    input: HandOverAccountingExportRequest,
    caller: FinanceCaller,
  ): Promise<AccountingExportDetail> {
    await this.operations.run(
      'ACCOUNTING_EXPORT_HANDOVER',
      input.requestId,
      {
        code,
        handedOverOn: input.handedOverOn,
        note: input.note ?? null,
        actorId: caller.principal.userId,
      },
      async (tx) => {
        const record = await tx.export.findUnique({ where: { code }, select: { id: true } });
        if (!record) throw new NotFoundException('Export nenalezen');
        try {
          await tx.exportEvent.create({
            data: {
              exportId: record.id,
              type: 'HANDED_OVER',
              handedOverOn: new Date(`${input.handedOverOn}T00:00:00Z`),
              note: input.note ?? null,
              actorId: caller.principal.userId,
              actorName: caller.principal.displayName,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw domainError(409, 'ALREADY_HANDED_OVER', 'Export už je zapsaný jako předaný.');
          throw error;
        }
        return { code };
      },
    );
    return this.detail(code);
  }

  /** A stored result for the same request (replay), a conflict for another one, or null. */
  private async replayed(kind: string, requestId: string, payload: object): Promise<string | null> {
    const row = await this.prisma.operationRequest.findUnique({ where: { requestId } });
    if (!row) return null;
    if (row.kind !== kind || row.payloadSha256 !== payloadHash(kind, payload) || !row.result)
      throw idempotencyConflict();
    return (row.result as { code: string }).code;
  }

  /**
   * What an export of the month would contain now, compared with the earlier exports of that
   * month, plus what still blocks it. `lock`: inside the final transaction, the month's documents
   * are share-locked so a correction cannot slip in before the commit.
   */
  private async plan(
    tx: Tx,
    handoverMonth: string,
    mode: AccountingExportMode,
    lock = false,
  ): Promise<Plan> {
    const monthStart = monthDate(handoverMonth);
    if (lock)
      await tx.$queryRaw`
        SELECT "id" FROM "finance"."documents" WHERE "handover_month" = ${monthStart}::date FOR SHARE`;
    const docs = await tx.document.findMany({
      where: { handoverMonth: monthStart },
      include: {
        events: { orderBy: { version: 'desc' }, take: 1, select: { snapshot: true } },
        exportItems: {
          where: { export: { handoverMonth: monthStart } },
          select: { documentVersion: true, change: true },
        },
      },
      orderBy: [{ issuedOn: 'asc' }, { serial: 'asc' }],
    });
    const candidates: Candidate[] = [];
    const incomplete: Plan['incomplete'] = [];
    for (const d of docs) {
      const handed = d.exportItems.filter((i) => i.change !== 'VOIDED');
      const lastHanded = handed.reduce((n, i) => Math.max(n, i.documentVersion), 0);
      let change: AccountingExportChange | null;
      if (d.status === 'VOIDED') {
        // Listed once, if it was handed over before (otherwise it never existed for the accountant).
        change =
          lastHanded > 0 && !d.exportItems.some((i) => i.change === 'VOIDED') ? 'VOIDED' : null;
      } else {
        const missing = missingForExport(d);
        if (missing.length > 0) {
          incomplete.push({ code: d.code, missing });
          continue;
        }
        if (lastHanded === 0) change = 'NEW';
        else if (lastHanded < d.version) change = 'CHANGED';
        else change = mode === 'FULL' ? 'INCLUDED' : null;
      }
      if (!change) continue;
      const snapshot = d.events[0]!.snapshot as Snapshot;
      candidates.push({
        doc: d,
        change,
        snapshot,
        line: lineOf(d, snapshot, d.version, change),
        withFile: change !== 'VOIDED',
      });
    }
    const unassigned = await tx.document.count({
      where: { handoverMonth: null, status: 'ACTIVE' },
    });
    const fingerprint = createHash('sha256')
      .update(
        canonicalJson({
          handoverMonth,
          mode,
          lines: candidates.map((c) => [c.doc.id, c.doc.version, c.change, c.doc.sha256]),
          incomplete: incomplete.map((i) => i.code),
        }),
      )
      .digest('hex');
    return { candidates, incomplete, unassigned, fingerprint };
  }

  /**
   * What differs from THIS export now (review F-R6): documents of its month added later (complete
   * and valid), documents it contains in a newer version (also moved to another month), and
   * documents it contains that are voided since — whatever other exports came after it.
   */
  private async laterChanges(record: {
    handoverMonth: Date;
    items: { documentId: string; documentVersion: number; change: string }[];
  }): Promise<AccountingExportLine[]> {
    const handed = new Map(record.items.map((i) => [i.documentId, i]));
    const docs = await this.prisma.document.findMany({
      where: {
        OR: [{ handoverMonth: record.handoverMonth }, { id: { in: [...handed.keys()] } }],
      },
      include: { events: { orderBy: { version: 'desc' }, take: 1, select: { snapshot: true } } },
    });
    const out: AccountingExportLine[] = [];
    for (const d of docs) {
      const item = handed.get(d.id);
      let change: AccountingExportChange | null = null;
      if (!item) {
        if (d.status === 'ACTIVE' && missingForExport(d).length === 0) change = 'NEW';
      } else if (d.status === 'VOIDED') {
        if (item.change !== 'VOIDED') change = 'VOIDED';
      } else if (d.version > item.documentVersion) change = 'CHANGED';
      if (change) out.push(lineOf(d, d.events[0]!.snapshot as Snapshot, d.version, change));
    }
    return out.sort(byIssueDate);
  }
}

const previewStale = () =>
  domainError(
    409,
    'PREVIEW_STALE',
    'Obsah exportu se od náhledu změnil. Načtěte nový náhled a potvrďte ho znovu.',
  );
const exportTooLarge = () =>
  domainError(
    422,
    'EXPORT_TOO_LARGE',
    `Export je příliš velký (nejvýše ${EXPORT_LIMITS.documents} dokladů a ${EXPORT_LIMITS.bytes / 1024 / 1024} MB originálů).`,
  );
const bytesOf = (cs: readonly Candidate[]) =>
  cs.reduce((n, c) => n + (c.withFile ? c.doc.byteSize : 0), 0);
const tooLarge = (count: number, bytes: number) =>
  count > EXPORT_LIMITS.documents || bytes > EXPORT_LIMITS.bytes;
const byIssueDate = (a: AccountingExportLine, b: AccountingExportLine) =>
  (a.issuedOn ?? '').localeCompare(b.issuedOn ?? '') || a.code.localeCompare(b.code);

/** Sums per currency of the valid lines (exact decimal strings, never converted or mixed). */
function totals(cs: readonly Candidate[]) {
  const cents = new Map<string, bigint>();
  for (const c of cs) {
    if (c.change === 'VOIDED' || !c.snapshot.totalAmount || !c.snapshot.currency) continue;
    const [whole, fraction = ''] = c.snapshot.totalAmount.replace('-', '').split('.');
    const value = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
    const signed = c.snapshot.totalAmount.startsWith('-') ? -value : value;
    cents.set(c.snapshot.currency, (cents.get(c.snapshot.currency) ?? 0n) + signed);
  }
  return [...cents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, v]) => {
      const abs = v < 0n ? -v : v;
      return {
        currency,
        amount: `${v < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`,
      };
    });
}

/** The ZIP: manifest.csv (UTF-8 BOM, ";", CRLF), README.txt and doklady/<code>-<name>. */
function archive(
  handoverMonth: string,
  mode: AccountingExportMode,
  candidates: readonly Candidate[],
  files: readonly { name: string; data: Buffer; candidate: Candidate }[],
  suppliers: Map<string, { name: string; companyId: string | null; vatId: string | null }>,
): Buffer {
  const fileOf = new Map(files.map((f) => [f.candidate.doc.id, f.name]));
  const rows = candidates.map((c) => {
    const s = c.snapshot;
    const supplier = s.supplierId ? suppliers.get(s.supplierId) : undefined;
    return [
      c.doc.code,
      c.change,
      s.status ?? null,
      s.handoverMonth ?? null,
      supplier?.name ?? s.supplierName ?? null,
      supplier?.companyId ?? null,
      supplier?.vatId ?? null,
      s.kind ?? null,
      s.documentNumber ?? null,
      s.issuedOn ?? null,
      s.taxPointOn ?? null,
      s.dueOn ?? null,
      s.totalAmount ?? null,
      s.currency ?? null,
      s.description ?? null,
      c.doc.source === 'SUPPLIER_DOCUMENT' ? 'SKLAD' : 'FINANCE',
      fileOf.get(c.doc.id) ?? null,
      c.withFile ? c.doc.sha256 : null,
      c.doc.version,
    ];
  });
  const manifest = csvFile(
    [
      'kod',
      'zmena',
      'stav',
      'predavaci_mesic',
      'dodavatel',
      'ico_dodavatele',
      'dic_dodavatele',
      'druh',
      'cislo_dokladu',
      'datum_vystaveni',
      'duzp',
      'splatnost',
      'castka',
      'mena',
      'popis',
      'zdroj',
      'soubor',
      'sha256',
      'verze',
    ],
    rows,
  );
  const readme = [
    `AYVO OS — doklady pro účetní, předávací měsíc ${handoverMonth}`,
    `Druh: ${mode === 'FULL' ? 'úplný (všechny úplné platné doklady měsíce)' : 'doplňkový (jen nové, změněné a zrušené od dřívějších exportů měsíce)'}`,
    'manifest.csv: oddělovač ";", UTF-8. Sloupec "zmena": NEW = nový, CHANGED = změněné údaje,',
    'VOIDED = zrušený (bez souboru), INCLUDED = už předaný beze změny. Originály jsou nezměněné;',
    'sha256 ověří, že soubor odpovídá evidenci. Vytvoření balíčku neznamená předání ani zaúčtování.',
    '',
  ].join('\r\n');
  return buildZip([
    { name: 'manifest.csv', data: Buffer.from(manifest, 'utf8') },
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    ...files.map((f) => ({ name: f.name, data: f.data })),
  ]);
}

function lineOf(
  d: DocumentRow,
  s: Snapshot,
  version: number,
  change: AccountingExportChange,
): AccountingExportLine {
  return {
    code: d.code,
    supplier: s.supplierName ?? null,
    kind: s.kind as FinanceDocumentKind,
    documentNumber: s.documentNumber ?? null,
    issuedOn: s.issuedOn ?? null,
    totalAmount: s.totalAmount ?? null,
    currency: s.currency ?? null,
    version,
    change,
    byteSize: d.byteSize,
    source: d.source as FinanceDocumentSource,
  };
}

function toDto(r: {
  code: string;
  handoverMonth: Date;
  mode: string;
  note: string | null;
  documentCount: number;
  byteSize: number;
  sha256: string;
  createdAt: Date;
  createdByName: string;
  events: { type: string; handedOverOn: Date | null }[];
}): AccountingExport {
  return {
    code: r.code,
    handoverMonth: month(r.handoverMonth),
    mode: r.mode as AccountingExportMode,
    note: r.note,
    documentCount: r.documentCount,
    byteSize: r.byteSize,
    sha256: r.sha256,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdByName,
    handedOverOn: day(r.events.find((e) => e.type === 'HANDED_OVER')?.handedOverOn ?? null),
    downloads: r.events.filter((e) => e.type === 'DOWNLOADED').length,
  };
}

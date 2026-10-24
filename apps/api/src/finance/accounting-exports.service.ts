import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type AccountingExport,
  type AccountingExportChange,
  type AccountingExportDetail,
  type AccountingExportLine,
  type AccountingExportMode,
  type AccountingExportPeriod,
  type AccountingExportPreview,
  type CreateAccountingExportRequest,
  type FinanceDocumentKind,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ProcurementService } from '../procurement/procurement.service.js';
import { csvFile } from '../sales/sales-csv.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { buildZip } from './zip.js';

/** Bounds of one export (doc 039 §7): the package is built in memory. */
export const EXPORT_LIMITS = { documents: 1000, bytes: 200 * 1024 * 1024 } as const;
/** Serialises export creation: two supplements never hand over the same change twice. */
const EXPORT_LOCK = 0x41_59_56_4f_45_58; // "AYVOEX"

const day = (d: Date) => d.toISOString().slice(0, 10);
const date = (s: string) => new Date(`${s}T00:00:00Z`);

type Tx = Prisma.TransactionClient | PrismaService;

interface Candidate {
  documentId: string;
  version: number;
  change: AccountingExportChange;
  line: AccountingExportLine;
  storageKey: string | null; // null: voided (listed without the file)
  originalFilename: string;
  sha256: string;
  supplierId: string;
  snapshot: Record<string, string | null>;
}

/**
 * Finance — the export for the accountant (doc 039 §7, N2): for a period of issue dates, a ZIP
 * with a CSV manifest and the unchanged originals, recorded per document version. FULL = every
 * valid document of the period; SUPPLEMENT = only what is new, changed or voided since earlier
 * exports. Exports are append-only; what changed after an export stays visible on it.
 */
@Injectable()
export class AccountingExportsService {
  private readonly logger = new Logger(AccountingExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly procurement: ProcurementService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async preview(period: AccountingExportPeriod): Promise<AccountingExportPreview> {
    const candidates = await this.candidates(this.prisma, period);
    const totalBytes = candidates.reduce((n, c) => n + (c.storageKey ? c.line.byteSize : 0), 0);
    return {
      periodFrom: period.periodFrom,
      periodTo: period.periodTo,
      mode: period.mode,
      lines: candidates.map((c) => c.line),
      totalBytes,
      tooLarge: candidates.length > EXPORT_LIMITS.documents || totalBytes > EXPORT_LIMITS.bytes,
      limits: { ...EXPORT_LIMITS },
    };
  }

  async create(
    input: CreateAccountingExportRequest,
    actorId: string,
  ): Promise<AccountingExportDetail> {
    const previous = await this.prisma.accountingExport.findUnique({
      where: { requestId: input.requestId },
    });
    if (previous) {
      const same =
        previous.createdBy === actorId &&
        day(previous.periodFrom) === input.periodFrom &&
        day(previous.periodTo) === input.periodTo &&
        previous.mode === input.mode;
      if (!same) throw domainError(409, 'IDEMPOTENCY_CONFLICT', 'Request id already used');
      return this.detail(previous.code);
    }
    let storageKey: string | null = null;
    try {
      const code = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EXPORT_LOCK}::bigint)`;
          const candidates = await this.candidates(tx, input);
          if (candidates.length === 0)
            throw domainError(422, 'NOTHING_TO_EXPORT', 'V období není nic k předání.');
          const bytes = candidates.reduce((n, c) => n + (c.storageKey ? c.line.byteSize : 0), 0);
          if (candidates.length > EXPORT_LIMITS.documents || bytes > EXPORT_LIMITS.bytes)
            throw domainError(
              422,
              'EXPORT_TOO_LARGE',
              `Export je příliš velký (nejvýše ${EXPORT_LIMITS.documents} dokladů a ${EXPORT_LIMITS.bytes / 1024 / 1024} MB). Zvolte kratší období.`,
            );
          const { first } = await allocateSerials(tx, 'accounting_export', 1);
          const code = `AE-${String(first).padStart(6, '0')}`;
          const zip = await this.package(code, input, candidates);
          storageKey = newStorageKey('accounting-exports', 'zip');
          await this.storage.put(storageKey, zip);
          const record = await tx.accountingExport.create({
            data: {
              serial: first,
              code,
              periodFrom: date(input.periodFrom),
              periodTo: date(input.periodTo),
              mode: input.mode,
              note: input.note || null,
              documentCount: candidates.length,
              storageKey,
              sha256: createHash('sha256').update(zip).digest('hex'),
              byteSize: zip.length,
              createdBy: actorId,
              requestId: input.requestId,
            },
          });
          await tx.accountingExportItem.createMany({
            data: candidates.map((c) => ({
              exportId: record.id,
              documentId: c.documentId,
              documentVersion: c.version,
              change: c.change,
            })),
          });
          return code;
        },
        { maxWait: 20_000, timeout: 120_000 },
      );
      return this.detail(code);
    } catch (error) {
      if (storageKey)
        this.logger.warn(
          `Unreferenced accounting export file after a failed export: ${storageKey}`,
        );
      throw error;
    }
  }

  async list(): Promise<AccountingExport[]> {
    const rows = await this.prisma.accountingExport.findMany({
      include: { creator: { select: { displayName: true } } },
      orderBy: { serial: 'desc' },
      take: 200,
    });
    return rows.map(toDto);
  }

  async detail(code: string): Promise<AccountingExportDetail> {
    const record = await this.prisma.accountingExport.findUnique({
      where: { code },
      include: {
        creator: { select: { displayName: true } },
        items: {
          include: {
            document: {
              select: { code: true, byteSize: true, supplier: { select: { name: true } } },
            },
            event: { select: { snapshot: true } },
          },
        },
      },
    });
    if (!record) throw new NotFoundException('Export nenalezen');
    const lines = record.items
      .map((i) =>
        lineOf(
          i.document.code,
          i.document.supplier.name,
          i.event.snapshot as Record<string, string | null>,
          i.documentVersion,
          i.change as AccountingExportChange,
          i.document.byteSize,
        ),
      )
      .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.code.localeCompare(b.code));
    const later = await this.candidates(this.prisma, {
      periodFrom: day(record.periodFrom),
      periodTo: day(record.periodTo),
      mode: 'SUPPLEMENT',
    });
    return { ...toDto(record), lines, laterChanges: later.map((c) => c.line) };
  }

  async content(code: string) {
    const record = await this.prisma.accountingExport.findUnique({ where: { code } });
    if (!record) throw new NotFoundException('Export nenalezen');
    return {
      bytes: await this.storage.get(record.storageKey),
      filename: `${record.code}_${day(record.periodFrom)}_${day(record.periodTo)}.zip`,
    };
  }

  /** What the export of the period would hand over now, in issue-date order. */
  private async candidates(tx: Tx, period: AccountingExportPeriod): Promise<Candidate[]> {
    const docs = await tx.financeDocument.findMany({
      where: { issuedOn: { gte: date(period.periodFrom), lte: date(period.periodTo) } },
      include: {
        supplier: { select: { name: true } },
        events: { orderBy: { version: 'desc' }, take: 1, select: { snapshot: true } },
        exportItems: { select: { documentVersion: true, change: true } },
      },
      orderBy: [{ issuedOn: 'asc' }, { serial: 'asc' }],
    });
    const out: Candidate[] = [];
    for (const d of docs) {
      const handed = d.exportItems.filter((i) => i.change !== 'VOIDED');
      const lastHanded = handed.reduce((n, i) => Math.max(n, i.documentVersion), 0);
      let change: AccountingExportChange | null;
      if (d.status === 'VOIDED') {
        // Voided: listed once, if it was handed over before (otherwise it never existed for them).
        change =
          lastHanded > 0 && !d.exportItems.some((i) => i.change === 'VOIDED') ? 'VOIDED' : null;
      } else if (lastHanded === 0) change = 'NEW';
      else if (lastHanded < d.version) change = 'CHANGED';
      else change = period.mode === 'FULL' ? 'INCLUDED' : null;
      if (!change) continue;
      const snapshot = d.events[0]!.snapshot as Record<string, string | null>;
      out.push({
        documentId: d.id,
        version: d.version,
        change,
        line: lineOf(d.code, d.supplier.name, snapshot, d.version, change, d.byteSize),
        storageKey: change === 'VOIDED' ? null : d.storageKey,
        originalFilename: d.originalFilename,
        sha256: d.sha256,
        supplierId: d.supplierId,
        snapshot,
      });
    }
    return out;
  }

  /** The ZIP: manifest.csv (UTF-8 with BOM, ";", CRLF — Czech Excel) + doklady/<code>-<name>. */
  private async package(
    code: string,
    period: AccountingExportPeriod,
    candidates: readonly Candidate[],
  ): Promise<Buffer> {
    const suppliers = await this.procurement.supplierIdentities(
      candidates.map((c) => c.supplierId),
    );
    const files: { name: string; data: Buffer }[] = [];
    const rows: (string | number | null)[][] = [];
    for (const c of candidates) {
      const s = c.snapshot;
      const file = c.storageKey ? `doklady/${c.line.code}-${c.originalFilename}` : null;
      if (c.storageKey) {
        const data = await this.storage.get(c.storageKey);
        if (createHash('sha256').update(data).digest('hex') !== c.sha256)
          throw domainError(
            500,
            'STORED_FILE_CHANGED',
            `Uložený originál ${c.line.code} nesouhlasí.`,
          );
        files.push({ name: file!, data });
      }
      const supplier = suppliers.get(c.supplierId);
      rows.push([
        c.line.code,
        c.change,
        s.status ?? null,
        supplier?.name ?? c.line.supplier,
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
        file,
        c.storageKey ? c.sha256 : null,
        c.version,
      ]);
    }
    const manifest = csvFile(
      [
        'kod',
        'zmena',
        'stav',
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
        'soubor',
        'sha256',
        'verze',
      ],
      rows,
    );
    const readme = [
      `AYVO OS — export dokladů pro účetní ${code}`,
      `Období (datum vystavení): ${period.periodFrom} až ${period.periodTo}`,
      `Druh: ${period.mode === 'FULL' ? 'úplný (všechny platné doklady období)' : 'doplňkový (jen nové, změněné a zrušené od dřívějších exportů)'}`,
      'manifest.csv: oddělovač ";", UTF-8. Sloupec "zmena": NEW = nový, CHANGED = změněné údaje,',
      'VOIDED = zrušený (bez souboru), INCLUDED = už předaný beze změny. Originály jsou nezměněné;',
      'sha256 ověří, že soubor odpovídá evidenci.',
      '',
    ].join('\r\n');
    return buildZip([
      { name: 'manifest.csv', data: Buffer.from(manifest, 'utf8') },
      { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
      ...files,
    ]);
  }
}

function lineOf(
  code: string,
  supplier: string,
  s: Record<string, string | null>,
  version: number,
  change: AccountingExportChange,
  byteSize: number,
): AccountingExportLine {
  return {
    code,
    supplier,
    kind: s.kind as FinanceDocumentKind,
    documentNumber: s.documentNumber ?? '',
    issuedOn: s.issuedOn ?? '',
    totalAmount: s.totalAmount ?? null,
    currency: s.currency ?? null,
    version,
    change,
    byteSize,
  };
}

function toDto(r: {
  code: string;
  periodFrom: Date;
  periodTo: Date;
  mode: string;
  note: string | null;
  documentCount: number;
  byteSize: number;
  sha256: string;
  createdAt: Date;
  creator: { displayName: string };
}): AccountingExport {
  return {
    code: r.code,
    periodFrom: day(r.periodFrom),
    periodTo: day(r.periodTo),
    mode: r.mode as AccountingExportMode,
    note: r.note,
    documentCount: r.documentCount,
    byteSize: r.byteSize,
    sha256: r.sha256,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.creator.displayName,
  };
}

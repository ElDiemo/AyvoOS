import { createHash } from 'node:crypto';
import type {
  PortalIntrospection,
  PortalInvoice,
  PortalInvoiceListQuery,
  PortalInvoicePackageQuery,
  PortalInvoicePage,
} from '@ayvo/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { domainError } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import {
  FILE_STORAGE,
  StorageObjectTooLargeError,
  type FileStorage,
} from '../storage/file-storage.js';
import { csvFile } from './csv.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinancePortalPrismaService } from './finance-portal-prisma.service.js';
import { invoicePaymentState } from './payments.service.js';
import { buildZip } from './zip.js';

/**
 * Invoice kinds a portal may show (§5 `env_allowed`): TEST only where APP_ENV is development or
 * test, never in production. LIVE invoices do not exist yet (doc 040 §13), so production shows none.
 */
export function portalInvoiceKinds(appEnv: FinanceEnv['APP_ENV']): string[] {
  return appEnv === 'production' ? [] : ['TEST'];
}

/**
 * THE visibility predicate of a portal invoice (ADR 0045 §5), the only one: the list (before
 * ordering and paging, so counts and pages never reveal another invoice), the detail and the PDF
 * all put exactly this into their WHERE. An invoice `i` is visible when its kind is allowed here
 * and ONE active grant of the session covers it whole: the grant's payer is the payer stored on
 * the invoice, the invoice has lines, and every line's hotel (stored when issued) is in that
 * grant. Hotels of two grants are never combined; today's agreements are never consulted.
 */
export function visibleInvoice(grants: PortalIntrospection['grants'], kinds: string[]): Prisma.Sql {
  const set = JSON.stringify(grants.map((g) => ({ payer: g.payerCustomerId, hotels: g.hotelIds })));
  return Prisma.sql`i."kind" = ANY(${kinds}::text[])
    AND EXISTS (
      SELECT 1 FROM jsonb_to_recordset(${set}::jsonb) AS g("payer" uuid, "hotels" uuid[])
      WHERE g."payer" = i."customer_id"
        AND EXISTS (SELECT 1 FROM "finance"."invoice_lines" l WHERE l."invoice_id" = i."id")
        AND NOT EXISTS (
          SELECT 1 FROM "finance"."invoice_lines" l
          WHERE l."invoice_id" = i."id" AND NOT (l."hotel_id" = ANY(g."hotels"))
        )
    )`;
}

interface Row {
  id: string;
  number: string;
  kind: 'TEST';
  issued_on: Date;
  due_on: Date;
  period_month: Date;
  total: string;
  currency: string;
  cancelled: boolean;
  paid: string;
  hotels: { id: string; code: string; name: string }[];
}

const notFound = () => domainError(404, 'INVOICE_NOT_FOUND', 'No such invoice');
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * "Faktury" of the hotel portal (ADR 0045 §5): the issued snapshot, the payment state and
 * "stornovaná", read through the portal's reserved pool only, under the one predicate above.
 */
@Injectable()
export class FinancePortalInvoicesService {
  private readonly logger = new Logger(FinancePortalInvoicesService.name);
  /** One package is built at a time in this process (its PDFs are held in memory). */
  private packing = false;

  constructor(
    private readonly db: FinancePortalPrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  private where(scope: PortalIntrospection): Prisma.Sql {
    return visibleInvoice(scope.grants, portalInvoiceKinds(this.env.APP_ENV));
  }

  private select(where: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT i."id", i."number", i."kind", i."issued_on", i."due_on", i."period_month",
             i."total"::text AS "total", i."currency",
             (c."invoice_id" IS NOT NULL) AS "cancelled",
             COALESCE((SELECT sum(a."amount") FROM "finance"."payment_allocations" a
                        WHERE a."invoice_id" = i."id"), 0)::text AS "paid",
             (SELECT json_agg(json_build_object('id', l."hotel_id", 'code', l."hotel_code",
                                                'name', l."hotel_name") ORDER BY l."line_no")
                FROM "finance"."invoice_lines" l WHERE l."invoice_id" = i."id") AS "hotels"
      FROM "finance"."invoices" i
      LEFT JOIN "finance"."invoice_cancellations" c ON c."invoice_id" = i."id"
      WHERE ${where}`;
  }

  async list(scope: PortalIntrospection, q: PortalInvoiceListQuery): Promise<PortalInvoicePage> {
    if (scope.grants.length === 0)
      return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
    const where = this.where(scope);
    const [count] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM "finance"."invoices" i WHERE ${where}`;
    const rows = await this.db.$queryRaw<Row[]>`${this.select(where)}
      ORDER BY i."issued_on" DESC, i."serial" DESC
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    return { items: rows.map(toView), total: count!.n, page: q.page, pageSize: q.pageSize };
  }

  async detail(scope: PortalIntrospection, id: string): Promise<PortalInvoice> {
    if (scope.grants.length === 0) throw notFound();
    const [row] = await this.db.$queryRaw<Row[]>`${this.select(
      Prisma.sql`${this.where(scope)} AND i."id" = ${id}::uuid`,
    )}`;
    if (!row) throw notFound();
    return toView(row);
  }

  /**
   * The stored PDF of a visible invoice. The predicate runs on the portal pool and its connection
   * is free again before the file is read. The read is real bounded work: `signal` (the request's
   * deadline, or the client gone) stops it in the storage itself, bytes are counted as they arrive
   * and the read stops beyond the size limit, and it settles only once the storage resource is
   * released. The SHA-256 must be the one recorded at issue. Any failure → 503, nothing sent.
   */
  async pdf(
    scope: PortalIntrospection,
    id: string,
    signal: AbortSignal,
  ): Promise<{ number: string; bytes: Buffer }> {
    if (scope.grants.length === 0) throw notFound();
    const [row] = await this.db.$queryRaw<
      { number: string; pdf_storage_key: string; pdf_sha256: string }[]
    >`SELECT i."number", i."pdf_storage_key", i."pdf_sha256" FROM "finance"."invoices" i
      WHERE ${this.where(scope)} AND i."id" = ${id}::uuid`;
    if (!row) throw notFound();
    let bytes: Buffer;
    try {
      bytes = await this.storage.getBounded(row.pdf_storage_key, {
        signal,
        maxBytes: this.env.FINANCE_PORTAL_PDF_MAX_BYTES,
      });
    } catch (error) {
      this.logger.warn(`Portal PDF not read: ${(error as Error).name}`);
      throw unavailable();
    }
    if (createHash('sha256').update(bytes).digest('hex') !== row.pdf_sha256) {
      this.logger.error('Portal PDF does not match its recorded hash');
      throw unavailable();
    }
    return { number: row.number, bytes };
  }

  /**
   * "Balíček za období" (doc 040 §14): the visible invoices (THE predicate) whose billed month is
   * in [from, to], each once — a summary invoice over several hotels too, but only if one grant
   * covers it whole. The query ends before any file is read (no DB transaction is open while
   * packing). Bounded: at most FINANCE_PORTAL_PACKAGE_MAX_INVOICES invoices and
   * FINANCE_PORTAL_PACKAGE_MAX_BYTES of PDFs and of the finished ZIP (refused with
   * PACKAGE_TOO_LARGE before, while reading or before sending), one package at a time per process (else PACKAGE_BUSY), stopped by `signal`. Every
   * PDF must match the hash recorded at issue. The ZIP holds manifest.csv, README.txt and
   * faktury/<number>.pdf.
   */
  async package(
    scope: PortalIntrospection,
    q: PortalInvoicePackageQuery,
    signal: AbortSignal,
  ): Promise<{ name: string; bytes: Buffer }> {
    const empty = () =>
      domainError(404, 'NO_INVOICES', 'V tomto období nejsou žádné faktury, které můžete vidět.');
    if (scope.grants.length === 0) throw empty();
    if (this.packing)
      throw domainError(503, 'PACKAGE_BUSY', 'Balíček se právě připravuje. Zkuste to za chvíli.');
    this.packing = true;
    try {
      const max = this.env.FINANCE_PORTAL_PACKAGE_MAX_INVOICES;
      const inPeriod = Prisma.sql`${this.where(scope)}
        AND i."period_month" BETWEEN ${`${q.from}-01`}::date AND ${`${q.to}-01`}::date`;
      const files = await this.db.$queryRaw<
        { id: string; number: string; pdf_storage_key: string; pdf_sha256: string }[]
      >`SELECT i."id", i."number", i."pdf_storage_key", i."pdf_sha256"
          FROM "finance"."invoices" i WHERE ${inPeriod}
          ORDER BY i."period_month", i."issued_on", i."serial" LIMIT ${max + 1}`;
      if (files.length === 0) throw empty();
      if (files.length > max) throw tooLarge();
      const views = new Map(
        (
          await this.db.$queryRaw<Row[]>`${this.select(
            Prisma.sql`${inPeriod} AND i."id" = ANY(${files.map((f) => f.id)}::uuid[])`,
          )}`
        ).map((r) => [r.id, toView(r)]),
      );
      // No DB work from here on: the files are read with a shared byte budget.
      let budget = this.env.FINANCE_PORTAL_PACKAGE_MAX_BYTES;
      const entries: { name: string; data: Buffer }[] = [];
      const names = new Set<string>();
      for (const f of files) {
        if (signal.aborted) throw signal.reason;
        let bytes: Buffer;
        try {
          bytes = await this.storage.getBounded(f.pdf_storage_key, {
            signal,
            maxBytes: Math.min(budget, this.env.FINANCE_PORTAL_PDF_MAX_BYTES),
          });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          // Beyond what is left of the package's budget (not beyond one PDF's own limit).
          if (
            error instanceof StorageObjectTooLargeError &&
            budget < this.env.FINANCE_PORTAL_PDF_MAX_BYTES
          )
            throw tooLarge();
          this.logger.warn(`Portal package PDF not read: ${(error as Error).name}`);
          throw unavailable();
        }
        if (createHash('sha256').update(bytes).digest('hex') !== f.pdf_sha256) {
          this.logger.error('Portal package PDF does not match its recorded hash');
          throw unavailable();
        }
        budget -= bytes.length;
        let name = `faktury/${f.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
        for (let n = 2; names.has(name); n++) name = name.replace(/(-\d+)?\.pdf$/, `-${n}.pdf`);
        names.add(name);
        entries.push({ name, data: bytes });
      }
      const manifest = csvFile(
        [
          'cislo',
          'druh',
          'vystaveno',
          'splatnost',
          'obdobi',
          'celkem',
          'mena',
          'stav_platby',
          'uhrazeno',
          'zbyva',
          'stornovana',
          'hotely',
          'soubor',
          'sha256',
        ],
        files.map((f, i) => {
          const v = views.get(f.id)!;
          return [
            v.number,
            v.kind,
            v.issuedOn,
            v.dueOn,
            v.periodMonth,
            v.total,
            v.currency,
            v.paymentState,
            v.paid,
            v.remaining,
            v.cancelled ? 'ano' : 'ne',
            v.hotels.map((h) => `${h.code} ${h.name}`).join(', '),
            entries[i]!.name,
            f.pdf_sha256,
          ];
        }),
      );
      const test = [...views.values()].some((v) => v.kind === 'TEST');
      const readme = [
        `AYVO — vystavené faktury za období ${q.from} až ${q.to}`,
        'manifest.csv: oddělovač ";", UTF-8. Každá faktura je v balíčku jednou, i souhrnná za více hotelů.',
        'Sloupec stav_platby: UNPAID = neuhrazená, PARTIALLY_PAID = částečně uhrazená, PAID = uhrazená.',
        'sha256 ověří, že soubor odpovídá faktuře, jak byla vystavena.',
        ...(test ? ['TESTOVACÍ faktury nejsou daňové doklady.'] : []),
        '',
      ].join('\r\n');
      const zip = buildZip([
        { name: 'manifest.csv', data: Buffer.from(manifest, 'utf8') },
        { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
        ...entries,
      ]);
      entries.length = 0; // the inputs are no longer needed while the ZIP is sent
      // The finished archive (headers, manifest and README included) within the limit, before a
      // byte is sent: beyond it the user is told to shorten the period, never "unavailable".
      if (zip.length > this.env.FINANCE_PORTAL_PACKAGE_MAX_BYTES) throw tooLarge();
      return { name: `AYVO-faktury-${q.from}-${q.to}.zip`, bytes: zip };
    } finally {
      this.packing = false;
    }
  }
}

const tooLarge = () =>
  domainError(422, 'PACKAGE_TOO_LARGE', 'Balíček by byl příliš velký. Zvolte kratší období.');
const unavailable = () =>
  domainError(503, 'INVOICES_UNAVAILABLE', 'Faktury teď nejsou dostupné. Zkuste to za chvíli.');

function toView(r: Row): PortalInvoice {
  const total = new Prisma.Decimal(r.total);
  const state = invoicePaymentState(
    total,
    [{ amount: new Prisma.Decimal(r.paid) }],
    r.due_on,
    r.cancelled,
  );
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    issuedOn: day(r.issued_on),
    dueOn: day(r.due_on),
    periodMonth: day(r.period_month).slice(0, 7),
    total: total.toFixed(2),
    currency: r.currency,
    hotels: r.hotels ?? [],
    paymentState: state.state,
    paid: state.paid,
    remaining: state.remaining,
    cancelled: r.cancelled,
  };
}

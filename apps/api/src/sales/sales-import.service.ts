import { createHash } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SALES_IMPORT_MAX_COLUMNS,
  SALES_IMPORT_MAX_ROWS,
  SINGLE_IMPORT_FIELDS,
  type ConfirmImportRequest,
  type DuplicateHint,
  type ImportInspection,
  type ImportOptions,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportSummary,
} from '@ayvo/types';
import { CODE_PREFIX, formatCode } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { contactData, profileData, ProspectsService } from './prospects.service.js';
import type { Db, SalesScope } from './sales-access.js';
import { CsvError, parseCsv, suggestMapping, type ParsedCsv } from './sales-csv.js';
import { buildDrafts, fileDuplicates, type ImportDraft } from './sales-import-rows.js';
import { nameKey } from './sales-keys.js';

export interface UploadedCsv {
  buffer: Buffer;
  originalname: string;
  size: number;
}

type Accessible = DuplicateHint['accessible'];

/**
 * CSV import of prospects (doc 034 §13): inspect → map → preview (writes nothing) → confirm
 * (the selected rows in one transaction, idempotent per request id) → a result record that can be
 * found again. Ownership, the target owner and duplicates are checked again on confirmation.
 * The file is never stored; the result keeps row numbers and error codes only.
 */
@Injectable()
export class SalesImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly prospects: ProspectsService,
  ) {}

  inspect(file: UploadedCsv | undefined): ImportInspection {
    const csv = this.read(file);
    return {
      fileName: file!.originalname,
      encoding: csv.encoding,
      delimiter: csv.delimiter,
      headers: csv.headers,
      rowCount: csv.rows.length,
      sample: csv.rows.slice(0, 5).map((r) => r.cells),
      suggested: suggestMapping(csv.headers),
    };
  }

  async preview(
    scope: SalesScope,
    file: UploadedCsv | undefined,
    options: ImportOptions,
  ): Promise<ImportPreview> {
    const csv = this.read(file);
    this.checkMapping(csv, options);
    const owner = await this.owner(this.prisma, scope, options.ownerId);
    const { drafts, inFile, existing } = await this.analyse(this.prisma, scope, csv, options);
    const rows = drafts.map((d) =>
      previewRow(d, inFile.get(d.row) ?? [], existing.get(d.row) ?? []),
    );
    return {
      owner,
      rows,
      counts: {
        total: rows.length,
        valid: rows.filter((r) => !r.errors.length).length,
        withErrors: rows.filter((r) => r.errors.length).length,
        withDuplicates: rows.filter((r) => r.fileDuplicates.length || r.duplicates.length).length,
      },
    };
  }

  async confirm(
    scope: SalesScope,
    file: UploadedCsv | undefined,
    input: ConfirmImportRequest,
  ): Promise<{ code: string }> {
    const csv = this.read(file);
    this.checkMapping(csv, input);
    const fileSha256 = createHash('sha256').update(file!.buffer).digest('hex');
    const { requestId, ...decisions } = input;
    const { result } = await this.operations.run(
      'SALES_IMPORT',
      requestId,
      { actorId: scope.userId, fileSha256, fileName: file!.originalname, ...decisions },
      async (tx) => {
        // Checked again now — the owner may have lost Obchod since the preview.
        const owner = await this.owner(tx, scope, input.ownerId);
        const { drafts, inFile, existing } = await this.analyse(tx, scope, csv, input);
        const byRow = new Map(drafts.map((d) => [d.row, d]));
        const chosen = new Map<number, boolean>();
        for (const r of input.rows) {
          if (!byRow.has(r.row) || chosen.has(r.row)) {
            throw domainErrorWithDetails(
              422,
              'IMPORT_ROW_UNKNOWN',
              'A selected row is not in the file',
              {
                rows: [r.row],
              },
            );
          }
          chosen.set(r.row, r.acknowledgeDuplicates);
        }
        const invalid = [...chosen.keys()].filter((row) => byRow.get(row)!.errors.length);
        if (invalid.length) {
          throw domainErrorWithDetails(
            422,
            'IMPORT_ROWS_INVALID',
            'Selected rows have errors; fix them or leave them out',
            { rows: invalid },
          );
        }
        // Duplicates as they are now (a colleague may have added a prospect since the preview).
        const unconfirmed = [...chosen.entries()]
          .filter(
            ([row, ack]) =>
              !ack && ((inFile.get(row) ?? []).length || (existing.get(row) ?? []).length),
          )
          .map(([row]) => row);
        if (unconfirmed.length) {
          throw domainErrorWithDetails(
            409,
            'IMPORT_DUPLICATES_UNCONFIRMED',
            'Some selected rows look like existing prospects; check the preview again and confirm them',
            { rows: unconfirmed },
          );
        }

        const selected = drafts.filter((d) => chosen.has(d.row));
        const { first: importSerial } = await allocateSerials(tx, 'sales_import', 1);
        const code = formatCode(CODE_PREFIX.salesImport, importSerial);
        const record = await tx.salesImport.create({
          data: {
            serial: importSerial,
            code,
            fileName: file!.originalname.slice(0, 255) || 'import.csv',
            fileSha256,
            encoding: csv.encoding,
            delimiter: csv.delimiter,
            rowCount: drafts.length,
            createdCount: selected.length,
            ownerId: owner.id,
            createdBy: scope.userId,
            requestId,
            skipped: drafts
              .filter((d) => !chosen.has(d.row))
              .map((d) => ({ row: d.row, errors: d.errors.map((e) => e.code) })),
          },
        });
        const { first } = await allocateSerials(tx, 'sales_prospect', selected.length);
        const created = await tx.salesProspect.createManyAndReturn({
          data: selected.map((d, i) => {
            const serial = first + BigInt(i);
            return {
              serial,
              code: formatCode(CODE_PREFIX.salesProspect, serial),
              ...profileData({
                name: d.name!,
                countryCode: d.countryCode!,
                city: d.city,
                addressLine1: d.addressLine1,
                addressLine2: null,
                postalCode: d.postalCode,
                roomsEstimate: d.roomsEstimate,
                accommodationType: d.accommodationType,
                website: d.website,
                source: d.source,
                priority: d.priority,
                note: d.note,
              }),
              ownerId: owner.id,
              createdBy: scope.userId,
              updatedBy: scope.userId,
              importId: record.id,
              importRow: d.row,
            };
          }),
          select: { id: true, name: true, importRow: true },
        });
        const idOf = new Map(created.map((p) => [p.importRow!, p.id]));
        const withContact = selected.filter((d) => d.contact);
        const contacts = await tx.salesContact.createManyAndReturn({
          data: withContact.map((d) => ({
            prospectId: idOf.get(d.row)!,
            ...contactData({
              label: d.contact!.label!,
              position: d.contact!.position,
              email: d.contact!.email,
              phone: d.contact!.phone,
              note: null,
              isPrimary: true,
            }),
            createdBy: scope.userId,
            updatedBy: scope.userId,
          })),
          select: { id: true, prospectId: true, label: true },
        });
        await tx.salesEvent.createMany({
          data: [
            ...created.map((p) => ({
              prospectId: p.id,
              type: 'PROSPECT_CREATED',
              actorId: scope.userId,
              requestId,
              payload: {
                name: p.name,
                ownerId: owner.id,
                stage: 'NEW',
                importCode: code,
                importRow: p.importRow,
              },
            })),
            ...contacts.map((c) => ({
              prospectId: c.prospectId,
              type: 'CONTACT_ADDED',
              actorId: scope.userId,
              requestId,
              contactId: c.id,
              payload: { label: c.label, importCode: code },
            })),
          ],
        });
        return { code };
      },
    );
    return result;
  }

  async result(scope: SalesScope, code: string): Promise<ImportResult> {
    const r = await this.prisma.salesImport.findUnique({
      where: { code },
      include: {
        owner: { select: { id: true, displayName: true } },
        creator: { select: { displayName: true } },
        prospects: {
          select: { code: true, name: true, importRow: true, ownerId: true },
          orderBy: { importRow: 'asc' },
        },
      },
    });
    // Only the person who imported (or sales:manage) — never another salesperson.
    if (!r || (!scope.all && r.createdBy !== scope.userId)) {
      throw new NotFoundException('Import not found');
    }
    const visible = r.prospects.filter((p) => scope.all || p.ownerId === scope.userId);
    return {
      code: r.code,
      fileName: r.fileName,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.creator.displayName,
      owner: { id: r.owner.id, name: r.owner.displayName },
      rowCount: r.rowCount,
      createdCount: r.createdCount,
      created: visible.map((p) => ({ row: p.importRow!, code: p.code, name: p.name })),
      createdNotVisible: r.prospects.length - visible.length,
      skipped: r.skipped as ImportResult['skipped'],
    };
  }

  async list(scope: SalesScope): Promise<ImportSummary[]> {
    const rows = await this.prisma.salesImport.findMany({
      where: scope.all ? {} : { createdBy: scope.userId },
      include: {
        owner: { select: { displayName: true } },
        creator: { select: { displayName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { serial: 'desc' }],
      take: 20,
    });
    return rows.map((r) => ({
      code: r.code,
      fileName: r.fileName,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.creator.displayName,
      owner: r.owner.displayName,
      rowCount: r.rowCount,
      createdCount: r.createdCount,
    }));
  }

  // --- helpers -------------------------------------------------------------------------------

  private read(file: UploadedCsv | undefined): ParsedCsv {
    if (!file) throw domainError(400, 'IMPORT_FILE_MISSING', 'Attach the CSV file as "file"');
    let csv: ParsedCsv;
    try {
      csv = parseCsv(file.buffer);
    } catch (e) {
      if (e instanceof CsvError) {
        throw domainErrorWithDetails(422, e.code, 'The file cannot be read as CSV', {
          line: e.line,
        });
      }
      throw e;
    }
    if (csv.headers.length > SALES_IMPORT_MAX_COLUMNS) {
      throw domainErrorWithDetails(422, 'IMPORT_TOO_MANY_COLUMNS', 'Too many columns', {
        limit: SALES_IMPORT_MAX_COLUMNS,
      });
    }
    if (csv.rows.length > SALES_IMPORT_MAX_ROWS) {
      throw domainErrorWithDetails(422, 'IMPORT_TOO_MANY_ROWS', 'Too many rows', {
        limit: SALES_IMPORT_MAX_ROWS,
        rows: csv.rows.length,
      });
    }
    return csv;
  }

  private checkMapping(csv: ParsedCsv, options: ImportOptions) {
    if (options.mapping.length !== csv.headers.length) {
      throw domainError(422, 'IMPORT_MAPPING_MISMATCH', 'Map every column of the file once');
    }
    for (const f of SINGLE_IMPORT_FIELDS) {
      if (options.mapping.filter((m) => m === f).length > 1) {
        throw domainErrorWithDetails(422, 'IMPORT_MAPPING_DUPLICATE', 'A field is mapped twice', {
          field: f,
        });
      }
    }
    if (!options.mapping.includes('name')) {
      throw domainError(422, 'IMPORT_NAME_NOT_MAPPED', 'Choose the column with the hotel name');
    }
  }

  /** The target owner: the importer, or — with sales:manage — an explicitly chosen salesperson. */
  private async owner(db: Db, scope: SalesScope, ownerId: string | null) {
    if (ownerId && ownerId !== scope.userId && !scope.all) {
      throw new ForbiddenException('Only an administrator imports prospects for someone else');
    }
    const id = ownerId ?? scope.userId;
    const person = await this.prospects.assertSalesperson(db, id);
    return { id: person.id, name: person.displayName };
  }

  private async analyse(db: Db, scope: SalesScope, csv: ParsedCsv, options: ImportOptions) {
    const drafts = buildDrafts(csv, options);
    return {
      drafts,
      inFile: fileDuplicates(drafts),
      existing: await existingDuplicates(db, scope, drafts),
    };
  }
}

/** Possible duplicates among the prospects the user may see (the same rules as doc 034 §8). */
async function existingDuplicates(
  db: Db,
  scope: SalesScope,
  drafts: ImportDraft[],
): Promise<Map<number, Accessible>> {
  const names = [...new Set(drafts.filter((d) => d.name).map((d) => nameKey(d.name!)))];
  const sites = [...new Set(drafts.map((d) => d.keys.website).filter((k): k is string => !!k))];
  const emails = [...new Set(drafts.map((d) => d.keys.email).filter((k): k is string => !!k))];
  const phones = [...new Set(drafts.map((d) => d.keys.phone).filter((k): k is string => !!k))];
  const out = new Map<number, Accessible>();
  if (!names.length && !sites.length && !emails.length && !phones.length) return out;
  const arr = (xs: string[]) => (xs.length ? xs : null);
  const rows = await db.$queryRaw<
    {
      code: string;
      name: string;
      city: string | null;
      owner: string;
      archived: boolean;
      name_key: string;
      country_code: string;
      website_key: string | null;
      emails: string[];
      phones: string[];
    }[]
  >`
    SELECT p."code", p."name", p."city", o."display_name" AS "owner", (p."archived_at" IS NOT NULL) AS "archived",
      p."name_key", p."country_code", p."website_key",
      ARRAY(SELECT x."email_key" FROM "sales_contacts" x WHERE x."prospect_id" = p."id" AND x."retired_at" IS NULL AND x."email_key" IS NOT NULL) AS "emails",
      ARRAY(SELECT x."phone_key" FROM "sales_contacts" x WHERE x."prospect_id" = p."id" AND x."retired_at" IS NULL AND x."phone_key" IS NOT NULL) AS "phones"
    FROM "sales_prospects" p JOIN "users" o ON o."id" = p."owner_id"
    WHERE (${scope.all}::boolean OR p."owner_id" = ${scope.userId}::uuid)
      AND (p."name_key" = ANY(${arr(names)}::text[]) OR p."website_key" = ANY(${arr(sites)}::text[])
        OR EXISTS (SELECT 1 FROM "sales_contacts" x WHERE x."prospect_id" = p."id" AND x."retired_at" IS NULL
          AND (x."email_key" = ANY(${arr(emails)}::text[]) OR x."phone_key" = ANY(${arr(phones)}::text[]))))
    ORDER BY p."code"
    LIMIT 10000`;
  for (const d of drafts) {
    const key = d.name ? nameKey(d.name) : null;
    const hits: Accessible = [];
    for (const p of rows) {
      const reasons: Accessible[number]['reasons'] = [];
      if (key && p.name_key === key && p.country_code === d.countryCode) reasons.push('NAME');
      if (d.keys.website && p.website_key === d.keys.website) reasons.push('WEBSITE');
      if (d.keys.email && p.emails.includes(d.keys.email)) reasons.push('EMAIL');
      if (d.keys.phone && p.phones.includes(d.keys.phone)) reasons.push('PHONE');
      if (reasons.length) {
        hits.push({
          code: p.code,
          name: p.name,
          city: p.city,
          owner: p.owner,
          reasons,
          archived: p.archived,
        });
      }
    }
    if (hits.length) out.set(d.row, hits.slice(0, 10));
  }
  return out;
}

function previewRow(d: ImportDraft, inFile: number[], duplicates: Accessible): ImportPreviewRow {
  return {
    row: d.row,
    name: d.name,
    countryCode: d.countryCode,
    city: d.city,
    contact: d.contact,
    priority: d.priority,
    roomsEstimate: d.roomsEstimate,
    note: d.note,
    errors: d.errors,
    fileDuplicates: inFile,
    duplicates,
  };
}

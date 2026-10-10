import type { LabelPrintJob as LabelPrintJobDto, LabelTemplateVersionRef } from '@ayvo/types';
import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BottlesService } from '../assets/bottles.service.js';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { publicQrUrl, qrBaseUrlViolation } from '../common/qr-policy.js';
import { ADMIN_API } from '../common/routes.js';
import { ENV, type Env } from '../config/env.js';
import { allocateSerials } from '../database/code-counters.js';
import { PrismaService } from '../database/prisma.service.js';
import type { LabelPrintJob } from '../generated/prisma/client.js';
import { LabelTemplatesService } from '../labels/label-templates.service.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { LabelPdfRenderer } from '../labels/label-pdf-renderer.js';

/** A GENERATING job older than this is considered abandoned (e.g. API restart) and may be retried. */
export const STALE_GENERATION_MS = 10 * 60 * 1000;

const SAFE_FAILURE_REASON =
  'PDF generation failed. Retry the generation; if it fails again, check the label template artwork.';

export interface PrintJobPdf {
  bytes: Buffer;
  filename: string;
}

/**
 * label-production module: print jobs render a FIXED set of bottles (job items, written once)
 * with a FIXED template version and public QR base URL. Rendering happens outside the bottle
 * creation transaction; a failed rendering never touches bottles, and a retry renders the very
 * same bottle identities again.
 */
@Injectable()
export class LabelPrintJobsService {
  private readonly logger = new Logger(LabelPrintJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bottles: BottlesService,
    private readonly labels: LabelTemplatesService,
    private readonly renderer: LabelPdfRenderer,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Creates a PENDING print job for every bottle of a creation batch, in code order. The job
   * snapshots the environment, the QR base URL, the error correction level and the exact QR URL
   * of every label. Refused if this process may not encode its configured base URL (ADR 0014).
   */
  async createForBatch(batchCode: string): Promise<LabelPrintJobDto> {
    this.assertQrPolicy(this.env.PUBLIC_QR_BASE_URL);
    const batch = await this.bottles.getBatchForPrinting(batchCode);
    const bottles = await this.bottles.listBatchBottlesForPrinting(batch.id);
    if (bottles.length !== batch.quantityCreated) throw new Error('Creation batch is incomplete');

    const job = await this.prisma.$transaction(async (tx) => {
      const { first: serial } = await allocateSerials(tx, 'label_print_job', 1);
      const created = await tx.labelPrintJob.create({
        data: {
          serial,
          code: formatCode(CODE_PREFIX.labelPrintJob, serial),
          creationBatchId: batch.id,
          labelTemplateVersionId: batch.labelTemplateVersionId,
          labelCount: bottles.length,
          publicBaseUrl: this.env.PUBLIC_QR_BASE_URL,
          appEnvironment: this.env.APP_ENV,
          qrErrorCorrection: this.env.LABEL_QR_ERROR_CORRECTION,
        },
      });
      await tx.labelPrintJobItem.createMany({
        data: bottles.map((b, position) => ({
          printJobId: created.id,
          position,
          bottleId: b.id,
          qrUrl: publicQrUrl(this.env.PUBLIC_QR_BASE_URL, b.publicToken),
        })),
      });
      return created;
    });
    return this.toDto(job, batch.code);
  }

  async listForBatch(batchCode: string): Promise<LabelPrintJobDto[]> {
    const batch = await this.bottles.getBatchForPrinting(batchCode);
    const jobs = await this.prisma.labelPrintJob.findMany({
      where: { creationBatchId: batch.id },
      orderBy: { serial: 'desc' },
    });
    const refs = await this.labels.getVersionRefs(jobs.map((j) => j.labelTemplateVersionId));
    return jobs.map((j) => toDto(j, batch.code, refs.get(j.labelTemplateVersionId)!));
  }

  async getByCode(code: string): Promise<LabelPrintJobDto> {
    const job = await this.findJob(code);
    return this.toDto(job, await this.batchCode(job));
  }

  /**
   * Renders the job's PDF (first run or retry of a FAILED/abandoned job). The claim is an atomic
   * conditional UPDATE, so two simultaneous requests never render the same job twice.
   */
  async generate(code: string): Promise<LabelPrintJobDto> {
    const job = await this.findJob(code);
    // A production process renders only production URLs; any other process never does.
    this.assertQrPolicy(job.publicBaseUrl);
    const now = new Date();
    // The claim identifies this attempt (attempts + 1); every later write is conditional on it,
    // so an attempt that was superseded (e.g. reclaimed after STALE_GENERATION_MS) can never
    // overwrite a newer outcome.
    const attempt = job.attempts + 1;
    const claimed = await this.prisma.labelPrintJob.updateMany({
      where: {
        id: job.id,
        attempts: job.attempts,
        OR: [
          { status: 'PENDING' },
          { status: 'FAILED' },
          {
            status: 'GENERATING',
            startedAt: { lt: new Date(now.getTime() - STALE_GENERATION_MS) },
          },
        ],
      },
      data: {
        status: 'GENERATING',
        startedAt: now,
        attempts: { increment: 1 },
        failedAt: null,
        failureReason: null,
      },
    });
    if (claimed.count === 0) {
      const current = await this.findJob(code);
      throw new ConflictException(
        current.status === 'COMPLETED'
          ? `${current.code} is already completed: download it, or create a new print job to regenerate`
          : `${current.code} is being generated right now`,
      );
    }

    // Order: render → store the file → mark COMPLETED. A job is COMPLETED only after its PDF is
    // durably stored. If the final DB write fails after the file was stored, the job stays
    // GENERATING (reclaimable after STALE_GENERATION_MS); the stored file is then an orphan,
    // logged with its key (doc 016, "Recovery").
    const ownsAttempt = { id: job.id, status: 'GENERATING' as const, attempts: attempt };
    let storageKey: string | null = null;
    try {
      const pdf = await this.render(job);
      storageKey = newStorageKey('label-print-jobs', 'pdf');
      await this.storage.put(storageKey, pdf);
      const done = await this.prisma.labelPrintJob.updateMany({
        where: ownsAttempt,
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          fileStorageKey: storageKey,
          fileByteSize: pdf.length,
          fileSha256: createHash('sha256').update(pdf).digest('hex'),
        },
      });
      if (done.count === 0) {
        this.logger.warn(
          `${job.code} attempt ${attempt} was superseded; orphaned file ${storageKey}`,
        );
      }
    } catch (error) {
      // Full details go to the server log only; the API returns a safe summary.
      this.logger.error(
        `Rendering ${job.code} attempt ${attempt} failed${storageKey ? ` (file key ${storageKey})` : ''}`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.prisma.labelPrintJob.updateMany({
        where: ownsAttempt,
        data: { status: 'FAILED', failedAt: new Date(), failureReason: SAFE_FAILURE_REASON },
      });
    }
    const finished = await this.findJob(code);
    return this.toDto(finished, await this.batchCode(finished));
  }

  async getPdf(code: string): Promise<PrintJobPdf> {
    const job = await this.findJob(code);
    if (job.status !== 'COMPLETED' || !job.fileStorageKey) {
      throw new ConflictException(`${job.code} has no PDF yet (status ${job.status})`);
    }
    const ref = (await this.labels.getVersionRefs([job.labelTemplateVersionId])).get(
      job.labelTemplateVersionId,
    )!;
    const batchCode = await this.batchCode(job);
    return {
      bytes: await this.storage.get(job.fileStorageKey),
      filename: `${job.code}_${batchCode}_${ref.templateName}-v${ref.versionNumber}_${job.labelCount}-labels.pdf`,
    };
  }

  private async render(job: LabelPrintJob): Promise<Buffer> {
    const items = await this.prisma.labelPrintJobItem.findMany({
      where: { printJobId: job.id },
      orderBy: { position: 'asc' },
      select: { bottleId: true, qrUrl: true },
    });
    if (items.length !== job.labelCount)
      throw new Error('Print job items do not match the label count');
    const bottles = await this.bottles.getPrintIdentities(items.map((i) => i.bottleId));
    const template = await this.labels.getRenderableVersion(job.labelTemplateVersionId);
    const pdf = await this.renderer.render({
      title: `${job.code} · ${template.ref.label} · ${job.labelCount} labels`,
      template,
      // Exactly the URLs stored when the job was created.
      labels: items.map((item, i) => ({ code: bottles[i]!.code, url: item.qrUrl })),
      errorCorrection: job.qrErrorCorrection,
      devMarker: job.appEnvironment !== 'production',
    });
    return Buffer.from(pdf);
  }

  private assertQrPolicy(baseUrl: string): void {
    const violation = qrBaseUrlViolation(this.env.APP_ENV, baseUrl);
    if (violation) throw new ForbiddenException(violation);
  }

  private async findJob(code: string): Promise<LabelPrintJob> {
    const serial = parseCodeSerial(CODE_PREFIX.labelPrintJob, code);
    const job =
      serial === null ? null : await this.prisma.labelPrintJob.findUnique({ where: { serial } });
    if (!job) throw new NotFoundException('Print job not found');
    return job;
  }

  private async batchCode(job: LabelPrintJob): Promise<string> {
    return this.bottles.getBatchCode(job.creationBatchId);
  }

  private async toDto(job: LabelPrintJob, batchCode: string): Promise<LabelPrintJobDto> {
    const refs = await this.labels.getVersionRefs([job.labelTemplateVersionId]);
    return toDto(job, batchCode, refs.get(job.labelTemplateVersionId)!);
  }
}

function toDto(
  job: LabelPrintJob,
  batchCode: string,
  ref: LabelTemplateVersionRef,
): LabelPrintJobDto {
  return {
    code: job.code,
    status: job.status,
    creationBatchCode: batchCode,
    labelTemplate: ref,
    labelCount: job.labelCount,
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    failedAt: job.failedAt?.toISOString() ?? null,
    failureReason: job.failureReason,
    fileByteSize: job.fileByteSize,
    environment: job.appEnvironment,
    qrErrorCorrection: job.qrErrorCorrection,
    downloadUrl:
      job.status === 'COMPLETED' ? `${ADMIN_API}/label-print-jobs/${job.code}/pdf` : null,
  };
}

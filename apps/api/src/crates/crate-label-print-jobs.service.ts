import {
  type CrateLabelPrintJob as CrateLabelPrintJobDto,
  type CreateCrateLabelPrintJobRequest,
} from '@ayvo/types';
import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CODE_PREFIX, formatCode, parseCodeSerial } from '../common/codes.js';
import { domainError } from '../common/domain-error.js';
import { publicQrUrl, qrBaseUrlViolation } from '../common/qr-policy.js';
import { ADMIN_API } from '../common/routes.js';
import { ENV, type Env } from '../config/env.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CrateLabelPrintJob, Prisma } from '../generated/prisma/client.js';
import { CodeLabelRenderer } from '../labels/code-label-pdf.js';
import { VALIDATION_URL_BASE } from '../labels/calibration-pdf.js';
import {
  assertCodeLabelLayout as assertLayout,
  requireQrJobPrintable,
  requireQrLabelSettings,
} from '../labels/qr-label-settings.js';
import { FILE_STORAGE, newStorageKey, type FileStorage } from '../storage/file-storage.js';
import { CratesService } from './crates.service.js';

/** A GENERATING job older than this is considered abandoned and may be retried (as doc 016). */
const STALE_GENERATION_MS = 10 * 60 * 1000;
const SAFE_FAILURE_REASON = 'PDF generation failed. Retry the generation.';

const jobInclude = {
  creator: { select: { displayName: true } },
  items: { orderBy: { position: 'asc' as const }, include: { crate: { select: { code: true } } } },
} satisfies Prisma.CrateLabelPrintJobInclude;
type JobRecord = Prisma.CrateLabelPrintJobGetPayload<{ include: typeof jobInclude }>;

/** What a crate label says besides the QR: the type code and capacity (auxiliary only). */
const labelDetail = (type: { code: string; capacity: number }) =>
  `${type.code} · Kapacita ${type.capacity}`;

/**
 * Crate QR label print jobs (doc 025 A1). A job renders a FIXED list of crates of one site at a
 * chosen physical size with the environment's QR base URL (ADR 0014 policy, DB CHECK). A reprint
 * is simply a new job: the crate keeps its token, so the URL is the same. Creating a job is
 * idempotent per request id; rendering happens after the commit and can be retried.
 */
@Injectable()
export class CrateLabelPrintJobsService {
  private readonly logger = new Logger(CrateLabelPrintJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly crates: CratesService,
    private readonly renderer: CodeLabelRenderer,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Creates the job (one transaction with its crate events) and renders it. */
  async create(
    actorId: string,
    input: CreateCrateLabelPrintJobRequest,
    siteId: string,
  ): Promise<CrateLabelPrintJobDto> {
    this.assertQrPolicy(this.env.PUBLIC_QR_BASE_URL);
    const settings = requireQrLabelSettings(this.env);
    assertLayout(settings, input.widthMm, input.heightMm);
    const { result } = await this.operations.run(
      'CRATE_LABEL_PRINT',
      input.requestId,
      { actorId, siteId, ...input, requestId: undefined },
      async (tx) => {
        const serials = input.crateCodes.map((c) => parseCodeSerial(CODE_PREFIX.crate, c)!);
        const crates = await tx.crate.findMany({
          where: { serial: { in: serials }, siteId },
          select: { id: true, code: true, qrToken: true },
        });
        // Another site's crate is "not found", exactly like an unknown code (doc 022).
        if (crates.length !== input.crateCodes.length) {
          throw domainError(404, 'CRATE_NOT_FOUND', 'Crate not found');
        }
        const byCode = new Map(crates.map((c) => [c.code, c]));
        const { first: serial } = await allocateSerials(tx, 'label_print_job', 1);
        const job = await tx.crateLabelPrintJob.create({
          data: {
            serial,
            code: formatCode(CODE_PREFIX.labelPrintJob, serial),
            siteId,
            labelCount: crates.length,
            widthMm: input.widthMm,
            heightMm: input.heightMm,
            publicBaseUrl: this.env.PUBLIC_QR_BASE_URL,
            appEnvironment: this.env.APP_ENV,
            qrErrorCorrection: settings.errorCorrection,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        const ordered = input.crateCodes.map((code) => byCode.get(code)!);
        await tx.crateLabelPrintJobItem.createMany({
          data: ordered.map((c, position) => ({
            printJobId: job.id,
            position,
            crateId: c.id,
            qrUrl: publicQrUrl(this.env.PUBLIC_QR_BASE_URL, c.qrToken),
          })),
        });
        const occurredAt = new Date();
        await tx.crateEvent.createMany({
          data: ordered.map((c) => ({
            crateId: c.id,
            type: 'LABEL_PRINT_JOB_CREATED' as const,
            occurredAt,
            actorId,
            siteId,
            operationRequestId: input.requestId,
            printJobId: job.id,
          })),
        });
        return { code: job.code };
      },
    );
    const job = await this.findJob(result.code, siteId);
    // A replay of a request whose rendering never ran (or was interrupted) renders it now.
    if (job.status === 'PENDING') return this.generate(job.code, siteId);
    return toDto(job);
  }

  async getByCode(code: string, siteId: string): Promise<CrateLabelPrintJobDto> {
    return toDto(await this.findJob(code, siteId));
  }

  /** Newest first: every job that printed this crate. */
  async listForCrate(crateId: string): Promise<CrateLabelPrintJobDto[]> {
    const jobs = await this.prisma.crateLabelPrintJob.findMany({
      where: { items: { some: { crateId } } },
      include: jobInclude,
      orderBy: { serial: 'desc' },
    });
    return jobs.map(toDto);
  }

  /**
   * Renders (or retries) the job. The claim is a conditional UPDATE bound to the attempt number,
   * so two requests never render the same attempt and a superseded attempt never overwrites a
   * newer outcome (same protocol as bottle print jobs, doc 016).
   */
  async generate(code: string, siteId: string): Promise<CrateLabelPrintJobDto> {
    const job = await this.findJob(code, siteId);
    this.assertQrPolicy(job.publicBaseUrl);
    // Checked before the claim: a refused job keeps its state (and stays retryable).
    assertLayout(requireQrJobPrintable(this.env, job.qrErrorCorrection), job.widthMm, job.heightMm);
    const now = new Date();
    const attempt = job.attempts + 1;
    const claimed = await this.prisma.crateLabelPrintJob.updateMany({
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
      const current = await this.findJob(code, siteId);
      throw new ConflictException(
        current.status === 'COMPLETED'
          ? `${current.code} is already completed: download it, or create a new print job to reprint`
          : `${current.code} is being generated right now`,
      );
    }
    const ownsAttempt = { id: job.id, status: 'GENERATING' as const, attempts: attempt };
    let storageKey: string | null = null;
    try {
      const pdf = Buffer.from(
        await this.renderer.render({
          title: `${job.code} · ${job.labelCount} crate labels`,
          widthMm: job.widthMm,
          heightMm: job.heightMm,
          // Exactly the URLs stored when the job was created.
          labels: await this.labelsOf(job),
          errorCorrection: job.qrErrorCorrection,
          devMarker: job.appEnvironment !== 'production',
        }),
      );
      storageKey = newStorageKey('label-print-jobs', 'pdf');
      await this.storage.put(storageKey, pdf);
      const done = await this.prisma.crateLabelPrintJob.updateMany({
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
      this.logger.error(
        `Rendering ${job.code} attempt ${attempt} failed${storageKey ? ` (file key ${storageKey})` : ''}`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.prisma.crateLabelPrintJob.updateMany({
        where: ownsAttempt,
        data: { status: 'FAILED', failedAt: new Date(), failureReason: SAFE_FAILURE_REASON },
      });
    }
    return toDto(await this.findJob(code, siteId));
  }

  async getPdf(code: string, siteId: string): Promise<{ bytes: Buffer; filename: string }> {
    const job = await this.findJob(code, siteId);
    if (job.status !== 'COMPLETED' || !job.fileStorageKey) {
      throw new ConflictException(`${job.code} has no PDF yet (status ${job.status})`);
    }
    // A stored PDF is handed out only under the current, matching QR settings.
    assertLayout(requireQrJobPrintable(this.env, job.qrErrorCorrection), job.widthMm, job.heightMm);
    return {
      bytes: await this.storage.get(job.fileStorageKey),
      filename: `${job.code}_crates_${job.widthMm}x${job.heightMm}mm_${job.labelCount}-labels.pdf`,
    };
  }

  /**
   * A one-page preview at the chosen size. It encodes a placeholder URL on the reserved
   * `.invalid` domain (never a crate's real URL), is marked PREVIEW and records nothing.
   */
  async preview(
    widthMm: number,
    heightMm: number,
    crateTypeCode: string | undefined,
  ): Promise<Buffer> {
    const settings = requireQrLabelSettings(this.env);
    assertLayout(settings, widthMm, heightMm);
    const type = crateTypeCode
      ? await this.prisma.crateType.findUnique({ where: { code: crateTypeCode } })
      : null;
    if (crateTypeCode && !type) throw domainError(422, 'UNKNOWN_CRATE_TYPE', 'Unknown crate type');
    // Same length as a real URL of this environment, so the QR density matches.
    const pad = Math.max(0, this.env.PUBLIC_QR_BASE_URL.length - VALIDATION_URL_BASE.length - 1);
    const placeholder = `${VALIDATION_URL_BASE}/${'x'.repeat(pad)}`;
    const pdf = await this.renderer.render({
      title: 'Crate label preview',
      widthMm,
      heightMm,
      labels: [
        {
          code: formatCode(CODE_PREFIX.crate, 1n).replace(/\d/g, '0'),
          detail: type ? labelDetail(type) : 'TYP · Kapacita',
          url: `${placeholder}/${'0'.repeat(22)}`,
        },
      ],
      errorCorrection: settings.errorCorrection,
      devMarker: this.env.APP_ENV !== 'production',
      previewMarker: true,
    });
    return Buffer.from(pdf);
  }

  private async labelsOf(job: CrateLabelPrintJob) {
    const items = await this.prisma.crateLabelPrintJobItem.findMany({
      where: { printJobId: job.id },
      orderBy: { position: 'asc' },
      include: { crate: { include: { crateType: true } } },
    });
    if (items.length !== job.labelCount)
      throw new Error('Print job items do not match the label count');
    return items.map((i) => ({
      code: i.crate.code,
      detail: labelDetail(i.crate.crateType),
      url: i.qrUrl,
    }));
  }

  private assertQrPolicy(baseUrl: string): void {
    const violation = qrBaseUrlViolation(this.env.APP_ENV, baseUrl);
    if (violation) throw new ForbiddenException(violation);
  }

  /** A job of the given site; another site's job is "not found" (doc 022). */
  private async findJob(code: string, siteId: string): Promise<JobRecord> {
    const serial = parseCodeSerial(CODE_PREFIX.labelPrintJob, code);
    const job =
      serial === null
        ? null
        : await this.prisma.crateLabelPrintJob.findUnique({
            where: { serial },
            include: jobInclude,
          });
    if (!job || job.siteId !== siteId) throw new NotFoundException('Print job not found');
    return job;
  }
}

/** Exactly the states the claim in `generate` accepts. */
function claimable(job: CrateLabelPrintJob, now: Date): boolean {
  return (
    job.status === 'PENDING' ||
    job.status === 'FAILED' ||
    (job.status === 'GENERATING' &&
      !!job.startedAt &&
      job.startedAt.getTime() < now.getTime() - STALE_GENERATION_MS)
  );
}

function toDto(job: JobRecord): CrateLabelPrintJobDto {
  return {
    code: job.code,
    status: job.status,
    labelCount: job.labelCount,
    widthMm: job.widthMm,
    heightMm: job.heightMm,
    crateCodes: job.items.map((i) => i.crate.code),
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    createdBy: job.creator.displayName,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    failureReason: job.failureReason,
    environment: job.appEnvironment,
    qrErrorCorrection: job.qrErrorCorrection,
    downloadUrl:
      job.status === 'COMPLETED' ? `${ADMIN_API}/crate-label-print-jobs/${job.code}/pdf` : null,
    retryable: claimable(job, new Date()),
  };
}

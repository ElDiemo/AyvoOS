import { randomBytes } from 'node:crypto';
import type {
  AgentClaim,
  AgentHeartbeat,
  AgentHeartbeatRequest,
  AgentJobState,
  AgentResultRequest,
  PrintJobView,
} from '@ayvo/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CODE_PREFIX, formatCode } from '../common/codes.js';
import { domainError } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import type { AgentPrincipal } from './print-agent.guard.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** A claimed job must be started within this time, or it returns to the queue (nothing written). */
export const CLAIM_LEASE_SECONDS = 60;
/** A started job without a result after this time is UNCERTAIN (never retried automatically). */
export const SENDING_LEASE_SECONDS = 120;

export interface PrintItem {
  parcelId: string;
  labelId: string;
  fileKey: string;
  sha256: string;
  sizeBytes: number;
}

const jobGone = () => domainError(404, 'JOB_NOT_FOUND', 'No such job for this agent');

/**
 * The durable print queue (doc 030 §4, ADR 0028). PostgreSQL is the truth: one job per parcel
 * label bound to its printer at creation; one conditional update per transition; an append-only
 * history. The agent claims (SKIP LOCKED, lease), must START before writing (refused for a job
 * that became invalid), and reports SENT, FAILED_BEFORE_SEND or UNCERTAIN. Expired claims return to
 * the queue (nothing was written); started jobs without a result become UNCERTAIN — never retried
 * automatically. The orders module gives it the labels to print; it never reads orders' tables.
 */
@Injectable()
export class PrintQueueService {
  private readonly log = new Logger(PrintQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  // --- requests and jobs (called by the orders module inside its transactions) -------------

  async createRequest(
    tx: Tx,
    input: {
      siteId: string;
      orderId: string;
      shipmentId: string;
      parcelId: string | null;
      printerId: string;
      kind: 'SHIPMENT' | 'REPRINT';
      reason: string | null;
      duplicateAcknowledged: boolean;
      actorId: string;
      operationRequestId: string;
      at: Date;
    },
  ): Promise<string> {
    const row = await tx.printRequest.create({
      data: {
        siteId: input.siteId,
        orderId: input.orderId,
        shipmentId: input.shipmentId,
        parcelId: input.parcelId,
        printerId: input.printerId,
        kind: input.kind,
        reason: input.reason,
        duplicateAcknowledged: input.duplicateAcknowledged,
        requestedAt: input.at,
        requestedBy: input.actorId,
        operationRequestId: input.operationRequestId,
      },
    });
    return row.id;
  }

  /** Print requests of a shipment still waiting for their labels (with their printer's dpi). */
  waiting(tx: Db, shipmentId: string) {
    return tx.printRequest.findMany({
      where: { shipmentId, status: 'WAITING_FOR_LABELS' },
      include: { printer: { select: { dpi: true, agentId: true, enabled: true, name: true } } },
      orderBy: { requestedAt: 'asc' },
    });
  }

  /** Turns a waiting request into one job per label (bound to its printer and agent). */
  async enqueue(tx: Tx, requestId: string, items: PrintItem[], at: Date): Promise<void> {
    const request = await tx.printRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { printer: { select: { agentId: true } } },
    });
    if (request.status !== 'WAITING_FOR_LABELS') return;
    if (items.length === 0) {
      // Every label is already on its way to a printer: nothing more to print for this request.
      await tx.printRequest.update({
        where: { id: request.id },
        data: { status: 'QUEUED', resolvedAt: at },
      });
      return;
    }
    const { first } = await allocateSerials(tx, 'print_job', items.length);
    let serial = first;
    for (const item of items) {
      const job = await tx.printJob.create({
        data: {
          serial,
          code: formatCode(CODE_PREFIX.printJob, serial),
          siteId: request.siteId,
          printRequestId: request.id,
          orderId: request.orderId,
          shipmentId: request.shipmentId,
          parcelId: item.parcelId,
          labelId: item.labelId,
          fileKey: item.fileKey,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          printerId: request.printerId,
          agentId: request.printer.agentId,
          createdAt: at,
        },
      });
      await tx.printJobEvent.create({
        data: { jobId: job.id, status: 'QUEUED', occurredAt: at, actorUserId: request.requestedBy },
      });
      serial += 1n;
    }
    await tx.printRequest.update({
      where: { id: request.id },
      data: { status: 'QUEUED', resolvedAt: at },
    });
  }

  /** A parcel's job still on its way to a printer (at most one, enforced by the database). */
  activeJob(tx: Db, parcelId: string) {
    return tx.printJob.findFirst({
      where: { parcelId, status: { in: ['QUEUED', 'CLAIMED', 'SENDING'] } },
    });
  }

  /** Whether a label of this parcel may physically exist (a job SENT or UNCERTAIN). */
  async possiblyPrinted(tx: Db, parcelId: string): Promise<boolean> {
    return (
      (await tx.printJob.count({ where: { parcelId, status: { in: ['SENT', 'UNCERTAIN'] } } })) > 0
    );
  }

  /**
   * The shipment's cancellation (recorded in the same transaction): waiting requests and jobs not
   * started yet are cancelled — a started one ends as the agent reports it.
   */
  async cancelForShipment(tx: Tx, shipmentId: string, actorId: string, at: Date) {
    await tx.printRequest.updateMany({
      where: { shipmentId, status: 'WAITING_FOR_LABELS' },
      data: { status: 'CANCELLED', resolvedAt: at },
    });
    return this.cancelOpen(
      tx,
      Prisma.sql`"shipment_id" = ${shipmentId}::uuid`,
      actorId,
      at,
      'Příprava přepravy se ruší – štítek je neplatný',
    );
  }

  /**
   * A printer disabled or moved to another agent, or its agent revoked: its waiting requests and
   * jobs not started yet are cancelled (a started one ends as the agent reports it) — never left
   * to a device that will not print them, never redirected silently.
   */
  async cancelForPrinter(tx: Tx, printerId: string, actorId: string, at: Date, detail: string) {
    await tx.printRequest.updateMany({
      where: { printerId, status: 'WAITING_FOR_LABELS' },
      data: { status: 'CANCELLED', resolvedAt: at },
    });
    return this.cancelOpen(tx, Prisma.sql`"printer_id" = ${printerId}::uuid`, actorId, at, detail);
  }

  /** One conditional update (a concurrent start wins; nothing fails), then the history. */
  private async cancelOpen(
    tx: Tx,
    where: Prisma.Sql,
    actorId: string,
    at: Date,
    detail: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "print_jobs" SET "status" = 'CANCELLED', "finished_at" = ${at}, "detail" = ${detail}
       WHERE ${where} AND "status" IN ('QUEUED', 'CLAIMED')
      RETURNING "id"`;
    for (const r of rows) {
      await tx.printJobEvent.create({
        data: { jobId: r.id, status: 'CANCELLED', occurredAt: at, actorUserId: actorId, detail },
      });
    }
    return rows.length;
  }

  /** Cancels one job that has not started (an operator's decision, with a reason). */
  async cancelJob(tx: Tx, jobId: string, actorId: string, reason: string, at: Date) {
    const changed = await tx.printJob.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'CLAIMED'] } },
      data: { status: 'CANCELLED', finishedAt: at, detail: reason.slice(0, 1000) },
    });
    if (changed.count !== 1) {
      throw domainError(409, 'JOB_NOT_CANCELLABLE', 'The job already went to the printer');
    }
    await tx.printJobEvent.create({
      data: { jobId, status: 'CANCELLED', occurredAt: at, actorUserId: actorId, detail: reason },
    });
  }

  /** The jobs of these parcels for the order view, newest first. */
  async jobsOf(parcelIds: string[]): Promise<Map<string, PrintJobView[]>> {
    const jobs = await this.prisma.printJob.findMany({
      where: { parcelId: { in: parcelIds } },
      include: {
        printer: { select: { name: true } },
        request: {
          select: { kind: true, reason: true, requester: { select: { displayName: true } } },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { serial: 'desc' }],
    });
    const out = new Map<string, PrintJobView[]>();
    for (const j of jobs) {
      const list = out.get(j.parcelId) ?? [];
      list.push({
        code: j.code,
        status: j.status as PrintJobView['status'],
        kind: j.request.kind as PrintJobView['kind'],
        printer: j.printer.name,
        createdAt: j.createdAt.toISOString(),
        finishedAt: j.finishedAt?.toISOString() ?? null,
        detail: j.detail,
        requestedBy: j.request.requester.displayName,
        reason: j.request.reason,
      });
      out.set(j.parcelId, list);
    }
    return out;
  }

  // --- the agent's side ----------------------------------------------------------------------

  async heartbeat(agent: AgentPrincipal, input: AgentHeartbeatRequest): Promise<AgentHeartbeat> {
    const now = new Date();
    await this.prisma.printAgent.update({
      where: { id: agent.id },
      data: {
        lastSeenAt: now,
        lastVersion: input.version,
        // What the agent sees now; an ADMIN chooses from it — nothing is assigned here.
        ...(input.devices ? { detectedDevices: input.devices, detectedAt: now } : {}),
      },
    });
    for (const p of input.printers) {
      // Only its own printers; anything else is ignored.
      await this.prisma.printer.updateMany({
        where: { id: p.printerId, agentId: agent.id },
        data: { reportedState: p.state, reportedDetail: p.detail, reportedAt: now },
      });
    }
    const printers = await this.prisma.printer.findMany({
      where: { agentId: agent.id },
      select: { id: true, code: true, usbSerial: true, enabled: true },
      orderBy: { code: 'asc' },
    });
    return { agent: { code: agent.code, site: agent.siteCode }, printers };
  }

  /** The next job of this agent's enabled printers, claimed for it alone (or none). */
  async claim(agent: AgentPrincipal): Promise<AgentClaim> {
    await this.sweep();
    await this.prisma.printAgent.update({
      where: { id: agent.id },
      data: { lastSeenAt: new Date() },
    });
    const token = randomBytes(24).toString('base64url');
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "print_jobs" j
         SET "status" = 'CLAIMED', "claim_token" = ${token}, "claimed_at" = now(),
             "lease_until" = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS})
       WHERE j."id" = (SELECT q."id" FROM "print_jobs" q
                         JOIN "printers" p ON p."id" = q."printer_id"
                        WHERE q."agent_id" = ${agent.id}::uuid AND q."status" = 'QUEUED' AND p."enabled"
                        ORDER BY q."created_at", q."serial"
                        LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
      RETURNING j."id"`;
      if (rows.length === 0) return { job: null };
      const job = await tx.printJob.findUniqueOrThrow({
        where: { id: rows[0]!.id },
        include: { printer: { select: { usbSerial: true } } },
      });
      await tx.printJobEvent.create({
        data: { jobId: job.id, status: 'CLAIMED', occurredAt: job.claimedAt!, agentId: agent.id },
      });
      return {
        job: {
          id: job.id,
          code: job.code,
          printerId: job.printerId,
          usbSerial: job.printer.usbSerial,
          claimToken: token,
          leaseUntil: job.leaseUntil!.toISOString(),
          sizeBytes: job.sizeBytes,
          sha256: job.sha256,
        },
      };
    });
  }

  /** The stored ZPL of a job this agent holds (claimed or sending) — nothing else. */
  async data(agent: AgentPrincipal, jobId: string, claimToken: string): Promise<Buffer> {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, agentId: agent.id, claimToken, status: { in: ['CLAIMED', 'SENDING'] } },
      select: { fileKey: true },
    });
    if (!job) throw jobGone();
    return this.storage.get(job.fileKey);
  }

  /**
   * The agent asks to write now. Allowed only for its claimed job that is still valid (not
   * cancelled, claim not expired, printer enabled). Idempotent for the same claim.
   */
  async start(agent: AgentPrincipal, jobId: string, claimToken: string): Promise<AgentJobState> {
    return this.prisma.$transaction(async (tx) => {
      const job = await this.lockJob(tx, agent, jobId);
      if (job.claimToken !== claimToken) throw jobGone();
      if (job.status === 'SENDING') return { id: job.id, status: 'SENDING' };
      if (job.status !== 'CLAIMED' || !job.leaseUntil || job.leaseUntil.getTime() < Date.now()) {
        await tx.printJobEvent.create({
          data: {
            jobId: job.id,
            status: 'START_REFUSED',
            occurredAt: new Date(),
            agentId: agent.id,
            detail: `Job is ${job.status}`,
          },
        });
        throw domainError(409, 'JOB_NOT_STARTABLE', `The job is ${job.status}; do not print it`);
      }
      const printer = await tx.printer.findUniqueOrThrow({ where: { id: job.printerId } });
      const now = new Date();
      if (!printer.enabled) {
        await tx.printJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', finishedAt: now, detail: 'Tiskárna byla vypnuta' },
        });
        await tx.printJobEvent.create({
          data: {
            jobId: job.id,
            status: 'FAILED',
            occurredAt: now,
            agentId: agent.id,
            detail: 'Tiskárna byla vypnuta – nic se neodeslalo',
          },
        });
        throw domainError(409, 'JOB_NOT_STARTABLE', 'The printer is disabled; do not print');
      }
      await tx.printJob.update({
        where: { id: job.id },
        data: {
          status: 'SENDING',
          startedAt: now,
          leaseUntil: new Date(now.getTime() + SENDING_LEASE_SECONDS * 1000),
        },
      });
      await tx.printJobEvent.create({
        data: { jobId: job.id, status: 'SENDING', occurredAt: now, agentId: agent.id },
      });
      return { id: job.id, status: 'SENDING' };
    });
  }

  /**
   * The agent's report. SENT = every byte written to the device (not proof of a printed label);
   * FAILED_BEFORE_SEND = nothing written; UNCERTAIN = possibly written. A late, truthful report
   * after the server marked the job UNCERTAIN is recorded too. Idempotent.
   */
  async result(
    agent: AgentPrincipal,
    jobId: string,
    input: AgentResultRequest,
  ): Promise<AgentJobState> {
    return this.prisma.$transaction(async (tx) => {
      const job = await this.lockJob(tx, agent, jobId);
      if (job.claimToken !== input.claimToken) throw jobGone();
      const target =
        input.outcome === 'SENT' ? 'SENT' : input.outcome === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED';
      if (job.status === target) return { id: job.id, status: target };
      const allowed =
        (job.status === 'SENDING' && ['SENT', 'FAILED', 'UNCERTAIN'].includes(target)) ||
        (job.status === 'CLAIMED' && target === 'FAILED') ||
        (job.status === 'UNCERTAIN' && (target === 'SENT' || target === 'FAILED'));
      if (!allowed) {
        throw domainError(409, 'JOB_RESULT_REFUSED', `A ${job.status} job cannot become ${target}`);
      }
      const now = new Date();
      await tx.printJob.update({
        where: { id: job.id },
        data: {
          status: target,
          finishedAt: now,
          detail: input.detail?.slice(0, 1000) ?? job.detail,
        },
      });
      await tx.printJobEvent.create({
        data: {
          jobId: job.id,
          status: job.status === 'UNCERTAIN' ? 'LATE_REPORT' : target,
          occurredAt: now,
          agentId: agent.id,
          detail: (job.status === 'UNCERTAIN' ? `${target}: ` : '') + (input.detail ?? ''),
        },
      });
      return { id: job.id, status: target };
    });
  }

  /**
   * Expired leases (also run by the sweeper): a claim never started returns to the queue — the
   * agent writes only after a confirmed start; a started job without a result becomes UNCERTAIN.
   */
  async sweep(): Promise<{ requeued: number; uncertain: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const requeued = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "print_jobs" SET "status" = 'QUEUED', "claim_token" = NULL, "claimed_at" = NULL,
                              "lease_until" = NULL
       WHERE "status" = 'CLAIMED' AND "lease_until" < now()
      RETURNING "id"`;
      const uncertain = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "print_jobs" SET "status" = 'UNCERTAIN', "finished_at" = now(),
                              "detail" = 'Agent nenahlásil výsledek – štítek se mohl vytisknout'
       WHERE "status" = 'SENDING' AND "lease_until" < now()
      RETURNING "id"`;
      const now = new Date();
      for (const r of requeued) {
        await tx.printJobEvent.create({
          data: {
            jobId: r.id,
            status: 'CLAIM_EXPIRED',
            occurredAt: now,
            detail: 'Agent úlohu nespustil – vrácena do fronty',
          },
        });
      }
      for (const r of uncertain) {
        await tx.printJobEvent.create({
          data: {
            jobId: r.id,
            status: 'UNCERTAIN',
            occurredAt: now,
            detail: 'Bez výsledku od agenta',
          },
        });
      }
      return { requeued: requeued.map((r) => r.id), uncertain: uncertain.map((r) => r.id) };
    });
    for (const id of result.uncertain) {
      this.log.warn(`Print job ${id}: no result after sending started — UNCERTAIN`);
    }
    return { requeued: result.requeued.length, uncertain: result.uncertain.length };
  }

  private async lockJob(tx: Tx, agent: AgentPrincipal, jobId: string) {
    await tx.$executeRaw`SELECT 1 FROM "print_jobs" WHERE "id" = ${jobId}::uuid FOR UPDATE`;
    const job = await tx.printJob.findFirst({ where: { id: jobId, agentId: agent.id } });
    if (!job) throw jobGone();
    return job;
  }
}

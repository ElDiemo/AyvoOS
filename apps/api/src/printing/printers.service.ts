import {
  PRINTER_MODEL_SPEC,
  type CreatePrintAgentRequest,
  type DispatchPrinter,
  type PrintAgent,
  type PrintAgentToken,
  type Printer,
  type RevokePrintAgentRequest,
  type RotatePrintAgentRequest,
  type SavePrinterRequest,
  type SitePrinting,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { newAgentToken } from './agent-token.js';

type Tx = Prisma.TransactionClient;
/** An agent counts as online when it contacted the server within this time. */
const ONLINE_MS = 2 * 60 * 1000;

const agentView = (a: {
  id: string;
  code: string;
  name: string;
  tokenHint: string;
  tokenIssuedAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  lastVersion: string | null;
}): PrintAgent => ({
  id: a.id,
  code: a.code,
  name: a.name,
  tokenHint: a.tokenHint,
  tokenIssuedAt: a.tokenIssuedAt.toISOString(),
  revokedAt: a.revokedAt?.toISOString() ?? null,
  lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
  lastVersion: a.lastVersion,
  online: !a.revokedAt && !!a.lastSeenAt && Date.now() - a.lastSeenAt.getTime() < ONLINE_MS,
});

/**
 * Printers and print agents of a site (doc 030 §3, ADR 0028) — ADMIN only (`printing:manage`).
 * A printer belongs to one agent of its site; at most one is the site's default for dispatch.
 * Agent tokens are generated here, shown once and stored only as a SHA-256 hash; every change is
 * audited without a token.
 */
@Injectable()
export class PrintersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
  ) {}

  async view(siteId: string): Promise<SitePrinting> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, code: true, name: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    const [agents, printers] = await Promise.all([
      this.prisma.printAgent.findMany({ where: { siteId }, orderBy: { code: 'asc' } }),
      this.prisma.printer.findMany({
        where: { siteId },
        include: { agent: true, updater: { select: { displayName: true } } },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      site,
      agents: agents.map(agentView),
      printers: printers.map((p) => this.printerView(p)),
    };
  }

  private printerView(
    p: Prisma.PrinterGetPayload<{
      include: { agent: true; updater: { select: { displayName: true } } };
    }>,
  ): Printer {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      model: p.model as Printer['model'],
      dpi: p.dpi,
      agent: { id: p.agent.id, code: p.agent.code, name: p.agent.name },
      usbSerial: p.usbSerial,
      dispatchDefault: p.dispatchDefault,
      autoPrint: p.autoPrint,
      enabled: p.enabled,
      reportedState: p.reportedState as Printer['reportedState'],
      reportedDetail: p.reportedDetail,
      reportedAt: p.reportedAt?.toISOString() ?? null,
      updatedAt: p.updatedAt.toISOString(),
      updatedBy: p.updater.displayName,
    };
  }

  /** The site's enabled default dispatch printer, as the order needs to know it (or null). */
  async dispatchPrinter(siteId: string, db: Tx | PrismaService = this.prisma) {
    const p = await db.printer.findFirst({
      where: { siteId, dispatchDefault: true, enabled: true },
      include: { agent: true },
    });
    if (!p) return null;
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      model: PRINTER_MODEL_SPEC[p.model as keyof typeof PRINTER_MODEL_SPEC]?.name ?? p.model,
      dpi: p.dpi,
      autoPrint: p.autoPrint,
      reportedState: p.reportedState as DispatchPrinter['reportedState'],
      reportedAt: p.reportedAt?.toISOString() ?? null,
      agent: {
        code: p.agent.code,
        lastSeenAt: p.agent.lastSeenAt?.toISOString() ?? null,
        online: agentView(p.agent).online,
      },
    } satisfies DispatchPrinter;
  }

  /** A printer a user may print on now: of this site, enabled, its agent not revoked. */
  async usablePrinter(tx: Tx, siteId: string, printerId: string) {
    const p = await tx.printer.findFirst({
      where: { id: printerId, siteId },
      include: { agent: { select: { revokedAt: true } } },
    });
    if (!p) throw domainError(404, 'PRINTER_NOT_FOUND', 'This printer does not exist at this site');
    if (!p.enabled || p.agent.revokedAt) {
      throw domainError(409, 'PRINTER_DISABLED', 'This printer or its agent is disabled');
    }
    return p;
  }

  async createAgent(
    actorId: string,
    siteId: string,
    input: CreatePrintAgentRequest,
  ): Promise<PrintAgentToken> {
    let token: string | null = null;
    const { result } = await this.operations.run(
      'PRINT_AGENT_CREATE',
      input.requestId,
      { actorId, siteId, code: input.code, name: input.name },
      async (tx) => {
        await this.assertSite(tx, siteId);
        if (await tx.printAgent.findUnique({ where: { code: input.code } })) {
          throw domainError(409, 'CODE_TAKEN', 'This code is used already');
        }
        const t = newAgentToken();
        const now = new Date();
        const agent = await tx.printAgent.create({
          data: {
            code: input.code,
            name: input.name,
            siteId,
            tokenHash: t.hash,
            tokenHint: t.hint,
            tokenIssuedAt: now,
            createdAt: now,
            createdBy: actorId,
          },
        });
        await this.audit.record(
          {
            type: 'PRINT_AGENT_CREATED',
            actorUserId: actorId,
            siteId,
            payload: { agent: agent.code, tokenHint: t.hint },
          },
          tx,
        );
        token = t.token;
        return { agentId: agent.id };
      },
    );
    return this.agentToken(result.agentId, token);
  }

  async rotateAgent(
    actorId: string,
    siteId: string,
    agentId: string,
    input: RotatePrintAgentRequest,
  ): Promise<PrintAgentToken> {
    let token: string | null = null;
    await this.operations.run(
      'PRINT_AGENT_ROTATE',
      input.requestId,
      { actorId, siteId, agentId, reason: input.reason },
      async (tx) => {
        const agent = await this.lockAgent(tx, siteId, agentId);
        if (agent.revokedAt) throw domainError(409, 'AGENT_REVOKED', 'This agent is revoked');
        const t = newAgentToken();
        await tx.printAgent.update({
          where: { id: agentId },
          data: { tokenHash: t.hash, tokenHint: t.hint, tokenIssuedAt: new Date() },
        });
        await this.audit.record(
          {
            type: 'PRINT_AGENT_TOKEN_ROTATED',
            actorUserId: actorId,
            siteId,
            reason: input.reason,
            payload: { agent: agent.code, tokenHint: t.hint },
          },
          tx,
        );
        token = t.token;
        return { agentId };
      },
    );
    return this.agentToken(agentId, token);
  }

  /** Revokes an agent for good: its token stops working; its printers stop receiving jobs. */
  async revokeAgent(
    actorId: string,
    siteId: string,
    agentId: string,
    input: RevokePrintAgentRequest,
  ): Promise<SitePrinting> {
    await this.operations.run(
      'PRINT_AGENT_REVOKE',
      input.requestId,
      { actorId, siteId, agentId, reason: input.reason },
      async (tx) => {
        const agent = await this.lockAgent(tx, siteId, agentId);
        if (agent.revokedAt) return { agentId };
        const now = new Date();
        await tx.printAgent.update({
          where: { id: agentId },
          data: { revokedAt: now, revokedBy: actorId },
        });
        // Its printers stop being the default (a revoked agent can no longer print).
        await tx.printer.updateMany({
          where: { agentId, dispatchDefault: true },
          data: { dispatchDefault: false, updatedAt: now, updatedBy: actorId },
        });
        await this.audit.record(
          {
            type: 'PRINT_AGENT_REVOKED',
            actorUserId: actorId,
            siteId,
            reason: input.reason,
            payload: { agent: agent.code },
          },
          tx,
        );
        return { agentId };
      },
    );
    return this.view(siteId);
  }

  async savePrinter(
    actorId: string,
    siteId: string,
    input: SavePrinterRequest,
  ): Promise<SitePrinting> {
    await this.operations.run(
      'PRINTER_SAVE',
      input.requestId,
      { actorId, siteId, ...input, requestId: undefined },
      async (tx) => {
        await this.assertSite(tx, siteId);
        // The site row serializes saves (one default printer per site).
        await tx.$executeRaw`SELECT 1 FROM "sites" WHERE "id" = ${siteId}::uuid FOR UPDATE`;
        const agent = await tx.printAgent.findFirst({ where: { id: input.agentId, siteId } });
        if (!agent) throw domainError(422, 'AGENT_NOT_FOUND', 'Choose an agent of this site');
        if (agent.revokedAt && input.enabled) {
          throw domainError(409, 'AGENT_REVOKED', 'This agent is revoked');
        }
        const spec = PRINTER_MODEL_SPEC[input.model];
        if (input.dispatchDefault && !input.enabled) {
          throw domainError(422, 'DEFAULT_MUST_BE_ENABLED', 'The default printer must be enabled');
        }
        const now = new Date();
        const before = input.id
          ? await tx.printer.findFirst({ where: { id: input.id, siteId } })
          : null;
        if (input.id && !before) throw new NotFoundException('Printer not found');
        if (!before && (await tx.printer.findUnique({ where: { code: input.code } }))) {
          throw domainError(409, 'CODE_TAKEN', 'This code is used already');
        }
        if (before && before.code !== input.code) {
          throw domainError(422, 'CODE_FIXED', 'A printer keeps its code');
        }
        if (input.dispatchDefault) {
          // Another default stops being one. Existing print jobs keep their printer (doc 030 §3).
          await tx.printer.updateMany({
            where: { siteId, dispatchDefault: true, ...(before ? { id: { not: before.id } } : {}) },
            data: { dispatchDefault: false, updatedAt: now, updatedBy: actorId },
          });
        }
        const data = {
          name: input.name,
          agentId: input.agentId,
          model: input.model,
          language: spec.language,
          dpi: spec.dpi,
          connection: spec.connection,
          usbSerial: input.usbSerial,
          dispatchDefault: input.dispatchDefault,
          autoPrint: input.autoPrint,
          enabled: input.enabled,
          updatedAt: now,
          updatedBy: actorId,
        };
        const saved = before
          ? await tx.printer.update({ where: { id: before.id }, data })
          : await tx.printer.create({
              data: { ...data, code: input.code, siteId, createdAt: now, createdBy: actorId },
            });
        await this.audit.record(
          {
            type: 'PRINTER_SAVED',
            actorUserId: actorId,
            siteId,
            payload: {
              printer: saved.code,
              created: !before,
              agent: agent.code,
              dispatchDefault: input.dispatchDefault,
              autoPrint: input.autoPrint,
              enabled: input.enabled,
            },
          },
          tx,
        );
        return { printerId: saved.id };
      },
    );
    return this.view(siteId);
  }

  private async agentToken(agentId: string, token: string | null): Promise<PrintAgentToken> {
    const agent = await this.prisma.printAgent.findUniqueOrThrow({ where: { id: agentId } });
    return { agent: agentView(agent), token };
  }

  private async assertSite(tx: Tx, siteId: string) {
    const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) throw new NotFoundException('Site not found');
  }

  private async lockAgent(tx: Tx, siteId: string, agentId: string) {
    await tx.$executeRaw`SELECT 1 FROM "print_agents" WHERE "id" = ${agentId}::uuid FOR UPDATE`;
    const agent = await tx.printAgent.findFirst({ where: { id: agentId, siteId } });
    if (!agent) throw new NotFoundException('Print agent not found');
    return agent;
  }
}

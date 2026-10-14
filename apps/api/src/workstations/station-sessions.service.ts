import type {
  CurrentStationSession,
  OpenStationSessionRequest,
  StationSession,
  StationSessionResult,
  TakeoverStationSessionRequest,
} from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { classifyScannedQr } from '../common/qr-policy.js';
import { ENV, type Env } from '../config/env.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { QrRegistryService } from '../database/qr-registry.service.js';
import type { Prisma, WorkstationSession } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';
import { assertMayWorkAt, workRefusal } from './workstation-access.js';
import {
  toWorkstation,
  workstationInclude,
  WorkstationsService,
  type WorkstationRecord,
} from './workstations.service.js';

type SessionWithUser = WorkstationSession & { user: { displayName: string } };

/** Ended by someone else within this window: shown once to the former holder. */
const ENDED_BY_OTHER_WINDOW_MS = 12 * 60 * 60 * 1000;

const sessionNotOwned = () =>
  domainError(409, 'SESSION_NOT_OWNED', 'This work session is no longer yours');

/**
 * Work sessions at workstations (doc 026, owner B4). Scanning a station QR opens a session or
 * resumes the user's own one; a station in use by someone else is refused with who holds it.
 * Handover is voluntary (the holder leaves, the next authorized user scans — no supervisor);
 * a forced takeover needs `production:session_takeover` and a reason. Lease expiry changes
 * nothing by itself. Every operation re-validates the stored station (mode permission, active
 * site, warehouse) — never values from the request.
 *
 * Lock order: operation request → user (advisory, serialises one user's opens) → station row →
 * its sessions.
 */
@Injectable()
export class StationSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly stations: WorkstationsService,
    private readonly audit: AuditService,
    private readonly registry: QrRegistryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private leaseFrom(now: Date): Date {
    return new Date(now.getTime() + this.env.STATION_SESSION_LEASE_MINUTES * 60_000);
  }

  /** The station behind a scanned value; refusals name what was scanned instead. */
  private async stationOfScan(value: string): Promise<WorkstationRecord> {
    const scan = classifyScannedQr(value, this.env.PUBLIC_QR_BASE_URL);
    if (scan.kind === 'NOT_AYVO_QR') {
      throw domainError(422, 'NOT_AYVO_QR', 'This is not an AYVO QR code of this environment');
    }
    if (scan.kind === 'WRONG_ENVIRONMENT') {
      throw domainError(
        422,
        'WRONG_ENVIRONMENT',
        'This QR code belongs to another AYVO environment',
      );
    }
    const kind = await this.registry.kindOf(scan.token);
    if (kind && kind !== 'WORKSTATION') {
      throw domainError(422, 'NOT_A_STATION', 'This is not a workstation QR code');
    }
    const station = kind
      ? await this.prisma.workstation.findUnique({
          where: { qrToken: scan.token },
          include: workstationInclude,
        })
      : null;
    if (!station) throw domainError(422, 'UNKNOWN_STATION', 'No workstation has this QR code');
    return station;
  }

  private toSession(s: SessionWithUser): StationSession {
    return {
      id: s.id,
      status: s.status,
      user: s.user.displayName,
      openedAt: s.openedAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
      leaseExpiresAt: s.leaseExpiresAt.toISOString(),
    };
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`station-user:${userId}`}, 0))`;
  }

  private async lockStation(tx: Prisma.TransactionClient, id: string) {
    await tx.$executeRaw`SELECT 1 FROM "workstations" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }

  /** Scan of a station QR: open a session, or resume the caller's own one. */
  async open(
    principal: Principal,
    input: OpenStationSessionRequest,
  ): Promise<StationSessionResult> {
    const station = await this.stationOfScan(input.scannedValue);
    if (station.status !== 'ACTIVE') {
      throw domainError(409, 'STATION_INACTIVE', 'This workstation is deactivated');
    }
    assertMayWorkAt(principal, station, true);
    const { result } = await this.operations.run(
      'STATION_SESSION_OPEN',
      input.requestId,
      { actorId: principal.userId, station: station.id },
      async (tx) => {
        await this.lockUser(tx, principal.userId);
        await this.lockStation(tx, station.id);
        const current = await tx.workstation.findUniqueOrThrow({ where: { id: station.id } });
        if (current.status !== 'ACTIVE') {
          throw domainError(409, 'STATION_INACTIVE', 'This workstation is deactivated');
        }
        const now = new Date();
        const own = await tx.workstationSession.findFirst({
          where: { userId: principal.userId, status: 'ACTIVE' },
          include: { workstation: { select: { code: true, name: true } } },
        });
        if (own && own.workstationId !== station.id) {
          throw domainErrorWithDetails(
            409,
            'SESSION_ELSEWHERE',
            'Leave your current workstation first',
            { station: { code: own.workstation.code, name: own.workstation.name } },
          );
        }
        if (own) {
          await tx.workstationSessionEvent.create({
            data: {
              sessionId: own.id,
              type: 'RESUMED',
              actorId: principal.userId,
              operationRequestId: input.requestId,
            },
          });
          const resumed = await tx.workstationSession.update({
            where: { id: own.id },
            data: { lastActivityAt: now, leaseExpiresAt: this.leaseFrom(now) },
            include: { user: { select: { displayName: true } } },
          });
          return this.result('RESUMED', resumed, station);
        }
        const holder = await tx.workstationSession.findFirst({
          where: { workstationId: station.id, status: 'ACTIVE' },
          include: { user: { select: { displayName: true } } },
        });
        if (holder) throw this.inUse(holder, now);
        const opened = await this.openIn(tx, principal.userId, station, input.requestId, now);
        return this.result('OPENED', opened, station);
      },
    );
    return result;
  }

  /**
   * Forced takeover of an occupied station (owner B4: supervisor/ADMIN, reason). The previous
   * session ends TAKEN_OVER; the taker gets a new session in the same transaction.
   */
  async takeover(
    principal: Principal,
    sessionId: string,
    input: TakeoverStationSessionRequest,
  ): Promise<StationSessionResult> {
    if (!principal.permissions.has('production:session_takeover')) {
      throw domainError(403, 'FORBIDDEN', 'You may not take over a workstation');
    }
    const target = await this.prisma.workstationSession.findUnique({
      where: { id: sessionId },
      include: { workstation: { include: workstationInclude } },
    });
    if (!target) throw domainError(404, 'SESSION_NOT_FOUND', 'Work session not found');
    const station = target.workstation;
    assertMayWorkAt(principal, station, true);
    const { result } = await this.operations.run(
      'STATION_SESSION_TAKEOVER',
      input.requestId,
      { actorId: principal.userId, sessionId, reason: input.reason },
      async (tx) => {
        await this.lockUser(tx, principal.userId);
        await this.lockStation(tx, station.id);
        const held = await tx.workstationSession.findUniqueOrThrow({ where: { id: sessionId } });
        if (held.status !== 'ACTIVE') {
          throw domainError(409, 'SESSION_ENDED', 'This work session has already ended');
        }
        if (held.userId === principal.userId) {
          throw domainError(409, 'OWN_SESSION', 'This is your own work session');
        }
        const own = await tx.workstationSession.findFirst({
          where: { userId: principal.userId, status: 'ACTIVE' },
          include: { workstation: { select: { code: true, name: true } } },
        });
        if (own) {
          throw domainErrorWithDetails(
            409,
            'SESSION_ELSEWHERE',
            'Leave your current workstation first',
            { station: { code: own.workstation.code, name: own.workstation.name } },
          );
        }
        const now = new Date();
        await tx.workstationSessionEvent.create({
          data: {
            sessionId: held.id,
            type: 'TAKEN_OVER',
            actorId: principal.userId,
            operationRequestId: input.requestId,
            reason: input.reason,
          },
        });
        await tx.workstationSession.update({
          where: { id: held.id },
          data: {
            status: 'TAKEN_OVER',
            closedAt: now,
            closedBy: principal.userId,
            closeReason: input.reason,
          },
        });
        const opened = await this.openIn(tx, principal.userId, station, input.requestId, now);
        await this.audit.record(
          {
            type: 'STATION_SESSION_TAKEN_OVER',
            actorUserId: principal.userId,
            targetUserId: held.userId,
            siteId: station.siteId,
            reason: input.reason,
            payload: { workstation: station.code },
          },
          tx,
        );
        return this.result('TAKEN_OVER', opened, station);
      },
    );
    return result;
  }

  /**
   * Voluntary leave/handover: the holder ends their own session (no supervisor needed). Only the
   * owner check applies — leaving must stay possible after the user lost access to the station
   * (site switched, permission removed), so a scope change never locks anyone in.
   */
  async release(principal: Principal, sessionId: string, requestId: string): Promise<void> {
    await this.operations.run(
      'STATION_SESSION_RELEASE',
      requestId,
      { actorId: principal.userId, sessionId },
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "workstation_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
        if (!locked[0]) throw domainError(404, 'SESSION_NOT_FOUND', 'Work session not found');
        const session = await tx.workstationSession.findUniqueOrThrow({ where: { id: sessionId } });
        if (session.userId !== principal.userId || session.status !== 'ACTIVE') {
          throw sessionNotOwned();
        }
        await tx.workstationSessionEvent.create({
          data: {
            sessionId,
            type: 'RELEASED',
            actorId: principal.userId,
            operationRequestId: requestId,
          },
        });
        await tx.workstationSession.update({
          where: { id: sessionId },
          data: { status: 'RELEASED', closedAt: new Date(), closedBy: principal.userId },
        });
        return { released: sessionId };
      },
    );
  }

  /** Keeps the open station page's lease alive; refuses a session that is no longer the caller's. */
  async heartbeat(principal: Principal, sessionId: string): Promise<StationSession> {
    return this.prisma.$transaction(async (tx) => {
      const { session } = await this.requireActiveSession(tx, principal, sessionId);
      return this.toSession(session);
    });
  }

  /**
   * The caller's ACTIVE session, locked, with its station re-validated and the lease renewed —
   * the entry check of every station operation (A3/A4 scans build on it).
   */
  async requireActiveSession(
    tx: Prisma.TransactionClient,
    principal: Principal,
    sessionId: string,
  ): Promise<{ session: SessionWithUser; station: WorkstationRecord }> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "workstation_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
    if (!locked[0]) throw domainError(404, 'SESSION_NOT_FOUND', 'Work session not found');
    const session = await tx.workstationSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { workstation: { include: workstationInclude } },
    });
    if (session.userId !== principal.userId || session.status !== 'ACTIVE') throw sessionNotOwned();
    if (session.workstation.status !== 'ACTIVE') {
      throw domainError(409, 'STATION_INACTIVE', 'This workstation is deactivated');
    }
    assertMayWorkAt(principal, session.workstation, true);
    const now = new Date();
    const renewed = await tx.workstationSession.update({
      where: { id: sessionId },
      data: { lastActivityAt: now, leaseExpiresAt: this.leaseFrom(now) },
      include: { user: { select: { displayName: true } } },
    });
    return { session: renewed, station: session.workstation };
  }

  /** Read-only check of the caller's ACTIVE session at a station they may work at (no lock). */
  async readActiveSession(
    principal: Principal,
    sessionId: string,
  ): Promise<{ session: WorkstationSession; station: WorkstationRecord }> {
    const session = await this.prisma.workstationSession.findUnique({
      where: { id: sessionId },
      include: { workstation: { include: workstationInclude } },
    });
    if (!session) throw domainError(404, 'SESSION_NOT_FOUND', 'Work session not found');
    if (session.userId !== principal.userId || session.status !== 'ACTIVE') throw sessionNotOwned();
    assertMayWorkAt(principal, session.workstation, false);
    const { workstation, ...rest } = session;
    return { session: rest, station: workstation };
  }

  /** Sets the labelling context of a locked session (doc 025 A3) with its event. */
  async setLabelingContext(
    tx: Prisma.TransactionClient,
    sessionId: string,
    actorId: string,
    operationId: string,
    context: {
      productId: string;
      recipeVersionId: string;
      labelTemplateVersionId: string;
      sourceLotId: string;
      keepCrate: boolean;
    },
  ): Promise<void> {
    const { keepCrate, ...fields } = context;
    await tx.workstationSession.update({
      where: { id: sessionId },
      data: { ...fields, ...(keepCrate ? {} : { crateId: null }) },
    });
    await tx.workstationSessionEvent.create({
      data: { sessionId, type: 'CONTEXT_CHANGED', actorId, operationRequestId: operationId },
    });
  }

  /** Loads a crate at a locked session; refused while another active session has it loaded. */
  async loadCrate(
    tx: Prisma.TransactionClient,
    sessionId: string,
    crateId: string,
    actorId: string,
    operationId: string,
  ): Promise<void> {
    const holder = await tx.workstationSession.findFirst({
      where: { crateId, status: 'ACTIVE', id: { not: sessionId } },
      include: { user: { select: { displayName: true } }, workstation: { select: { name: true } } },
    });
    if (holder) {
      throw domainErrorWithDetails(409, 'CRATE_IN_USE', 'This crate is loaded at another station', {
        holder: holder.user.displayName,
        station: holder.workstation.name,
      });
    }
    await tx.workstationSession.update({ where: { id: sessionId }, data: { crateId } });
    await tx.workstationSessionEvent.create({
      data: { sessionId, type: 'CRATE_LOADED', actorId, operationRequestId: operationId },
    });
  }

  /**
   * The caller's active session — only if they may still work at its station right now (mode
   * permission, active site, PRODUCTION capability, warehouse); otherwise just `blocked` with the
   * refusal code, so the UI never shows a stale station context but the user can still leave it.
   * Also, once, the last session someone else ended (only for a station they may work at).
   */
  async current(principal: Principal): Promise<CurrentStationSession> {
    const active = await this.prisma.workstationSession.findFirst({
      where: { userId: principal.userId, status: 'ACTIVE' },
      include: {
        user: { select: { displayName: true } },
        workstation: { include: workstationInclude },
      },
    });
    if (active) {
      const refusal = workRefusal(principal, active.workstation);
      return refusal
        ? { current: null, blocked: { sessionId: active.id, code: refusal }, endedByOther: null }
        : {
            current: {
              session: this.toSession(active),
              station: toWorkstation(active.workstation),
            },
            blocked: null,
            endedByOther: null,
          };
    }
    const last = await this.prisma.workstationSession.findFirst({
      where: { userId: principal.userId },
      orderBy: { openedAt: 'desc' },
      include: {
        closer: { select: { displayName: true } },
        workstation: { include: workstationInclude },
      },
    });
    const endedByOther =
      last &&
      last.closedBy &&
      last.closedBy !== principal.userId &&
      last.closedAt &&
      Date.now() - last.closedAt.getTime() < ENDED_BY_OTHER_WINDOW_MS &&
      !workRefusal(principal, last.workstation)
        ? {
            station: toWorkstation(last.workstation),
            status: last.status,
            endedBy: last.closer!.displayName,
            endedAt: last.closedAt.toISOString(),
            reason: last.closeReason,
          }
        : null;
    return { current: null, blocked: null, endedByOther };
  }

  private async openIn(
    tx: Prisma.TransactionClient,
    userId: string,
    station: WorkstationRecord,
    requestId: string,
    now: Date,
  ): Promise<SessionWithUser> {
    const opened = await tx.workstationSession.create({
      data: {
        workstationId: station.id,
        userId,
        siteId: station.siteId,
        openedAt: now,
        lastActivityAt: now,
        leaseExpiresAt: this.leaseFrom(now),
      },
      include: { user: { select: { displayName: true } } },
    });
    await tx.workstationSessionEvent.create({
      data: {
        sessionId: opened.id,
        type: 'OPENED',
        actorId: userId,
        operationRequestId: requestId,
      },
    });
    return opened;
  }

  private inUse(holder: SessionWithUser, now: Date) {
    return domainErrorWithDetails(409, 'STATION_IN_USE', 'Another user works at this station', {
      sessionId: holder.id,
      holder: holder.user.displayName,
      lastActivityAt: holder.lastActivityAt.toISOString(),
      leaseExpired: this.stations.leaseExpired(holder, now),
    });
  }

  private result(
    outcome: StationSessionResult['outcome'],
    session: SessionWithUser,
    station: WorkstationRecord,
  ): StationSessionResult {
    return { outcome, session: this.toSession(session), station: toWorkstation(station) };
  }
}

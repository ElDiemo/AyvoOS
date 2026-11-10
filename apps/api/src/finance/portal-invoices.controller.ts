import {
  PORTAL_SESSION_HEADER,
  portalInvoiceListQuerySchema,
  portalInvoicePackageQuerySchema,
  type PortalInvoice,
  type PortalInvoiceListQuery,
  type PortalInvoicePackageQuery,
  type PortalInvoicePage,
} from '@ayvo/types';
import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PortalServiceAccess } from '../identity/access.decorators.js';
import { CoreClient } from './core-client.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinancePortalInvoicesService } from './portal-invoices.service.js';

/**
 * The portal routes' request limit in Finance (ADR 0045 §8): at most FINANCE_PORTAL_MAX_IN_FLIGHT
 * (2) at once, the rest 503 at once. A failure below a route that is not a domain answer is 503
 * without data — never a broader or a cached answer.
 */
@Injectable()
export class FinancePortalRequestLimit {
  private readonly logger = new Logger(FinancePortalRequestLimit.name);
  private active = 0;

  constructor(@Inject(FINANCE_ENV) private readonly env: FinanceEnv) {}

  get inFlight(): number {
    return this.active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.env.FINANCE_PORTAL_MAX_IN_FLIGHT)
      throw domainError(503, 'PORTAL_BUSY', 'Faktury jsou teď vytížené. Zkuste to za chvíli.');
    this.active++;
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(`Portal invoice request failed: ${(error as Error).name}`);
      throw domainError(
        503,
        'INVOICES_UNAVAILABLE',
        'Faktury teď nejsou dostupné. Zkuste to za chvíli.',
      );
    } finally {
      this.active--;
    }
  }
}

/**
 * "Faktury" of the hotel portal (ADR 0045 §5, §6): called only by portal-web with its own token,
 * with the browser's portal session forwarded. Finance never trusts a scope from portal-web: on
 * every request it asks the core what that session may see (`introspect-portal`), then answers
 * under its one visibility predicate. Another invoice is 404, exactly like a missing one.
 */
@Controller('internal/v1/portal/invoices')
export class FinancePortalInvoicesController {
  constructor(
    private readonly invoices: FinancePortalInvoicesService,
    private readonly core: CoreClient,
    private readonly slots: FinancePortalRequestLimit,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  private async scope(session: string | undefined) {
    if (!session) throw domainError(401, 'UNAUTHENTICATED', 'Sign-in is required');
    return this.core.introspectPortal(session);
  }

  @PortalServiceAccess()
  @Get()
  list(
    @Query(new ZodValidationPipe(portalInvoiceListQuerySchema)) q: PortalInvoiceListQuery,
    @Headers(PORTAL_SESSION_HEADER) session: string | undefined,
  ): Promise<PortalInvoicePage> {
    return this.slots.run(async () => this.invoices.list(await this.scope(session), q));
  }

  /**
   * "Balíček za období" (doc 040 §14): a ZIP of the visible invoices of the period with a
   * manifest. Declared before ":id". The same bounded sending as the PDF: one deadline
   * (FINANCE_PORTAL_PACKAGE_TIMEOUT_MS) for reading, packing and sending, the client leaving stops
   * it, the request slot is held until the bytes have left.
   */
  @PortalServiceAccess()
  @Get('package')
  package(
    @Query(new ZodValidationPipe(portalInvoicePackageQuerySchema)) q: PortalInvoicePackageQuery,
    @Headers(PORTAL_SESSION_HEADER) session: string | undefined,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.slots.run(async () => {
      // One package from its start until its bytes have left or the transfer was aborted.
      const release = this.invoices.reservePackage();
      if (!release)
        throw domainError(503, 'PACKAGE_BUSY', 'Balíček se právě připravuje. Zkuste to za chvíli.');
      try {
        await this.sendBounded(res, this.env.FINANCE_PORTAL_PACKAGE_TIMEOUT_MS, async (signal) => {
          const file = await this.invoices.package(await this.scope(session), q, signal);
          return { type: 'application/zip', name: file.name, bytes: file.bytes };
        });
      } finally {
        release();
      }
    });
  }

  @PortalServiceAccess()
  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) session: string | undefined,
  ): Promise<PortalInvoice> {
    return this.slots.run(async () => this.invoices.detail(await this.scope(session), id));
  }

  /**
   * The issued PDF: private, never cached, always a download, never sniffed. Its request slot is
   * held until the bytes have left — the response finished, the client gone, or the deadline
   * passed (then the connection is cut) — so slow receivers can never hold more PDFs in memory
   * than the request limit. One deadline (FINANCE_PORTAL_PDF_TIMEOUT_MS) covers reading and
   * sending; the client leaving stops the read too.
   */
  @PortalServiceAccess()
  @Get(':id/pdf')
  pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) session: string | undefined,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.slots.run(async () => {
      const stop = new AbortController();
      const deadline = setTimeout(
        () => stop.abort(new Error('PortalPdfDeadline')),
        this.env.FINANCE_PORTAL_PDF_TIMEOUT_MS,
      );
      const gone = () => {
        if (!res.writableFinished) stop.abort(new Error('PortalPdfClientGone'));
      };
      res.once('close', gone);
      try {
        const file = await this.invoices.pdf(await this.scope(session), id, stop.signal);
        if (stop.signal.aborted) throw stop.signal.reason;
        if (res.destroyed) return;
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          res.once('finish', done);
          res.once('close', done);
          // The deadline also bounds the sending: a receiver too slow is cut off.
          stop.signal.addEventListener('abort', () => res.destroy(), { once: true });
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': String(file.bytes.length),
            'Content-Disposition': `attachment; filename="${file.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(file.bytes);
        });
      } finally {
        clearTimeout(deadline);
        res.off('close', gone);
      }
    });
  }

  /** Produces a file under one deadline and sends it privately as a download, never sniffed. */
  private async sendBounded(
    res: ServerResponse,
    timeoutMs: number,
    produce: (signal: AbortSignal) => Promise<{ type: string; name: string; bytes: Buffer }>,
  ): Promise<void> {
    const stop = new AbortController();
    const deadline = setTimeout(() => stop.abort(new Error('PortalFileDeadline')), timeoutMs);
    const gone = () => {
      if (!res.writableFinished) stop.abort(new Error('PortalFileClientGone'));
    };
    res.once('close', gone);
    try {
      const file = await produce(stop.signal);
      if (stop.signal.aborted) throw stop.signal.reason;
      if (res.destroyed) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        res.once('finish', done);
        res.once('close', done);
        stop.signal.addEventListener('abort', () => res.destroy(), { once: true });
        res.writeHead(200, {
          'Content-Type': file.type,
          'Content-Length': String(file.bytes.length),
          'Content-Disposition': `attachment; filename="${file.name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(file.bytes);
      });
    } finally {
      clearTimeout(deadline);
      res.off('close', gone);
    }
  }
}

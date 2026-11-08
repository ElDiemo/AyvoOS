import {
  PORTAL_SESSION_HEADER,
  portalInvoiceListQuerySchema,
  type PortalInvoice,
  type PortalInvoiceListQuery,
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
  StreamableFile,
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

  @PortalServiceAccess()
  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) session: string | undefined,
  ): Promise<PortalInvoice> {
    return this.slots.run(async () => this.invoices.detail(await this.scope(session), id));
  }

  /** The issued PDF: private, never cached, always a download, never sniffed. */
  @PortalServiceAccess()
  @Get(':id/pdf')
  pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(PORTAL_SESSION_HEADER) session: string | undefined,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<StreamableFile> {
    return this.slots.run(async () => {
      const file = await this.invoices.pdf(await this.scope(session), id);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return new StreamableFile(file.bytes, {
        type: 'application/pdf',
        disposition: `attachment; filename="${file.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`,
        length: file.bytes.length,
      });
    });
  }
}

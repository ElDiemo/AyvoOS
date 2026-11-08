import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  financeContractHotelSchema,
  financeContractSupplierDocumentSchema,
  financeContractSupplierSchema,
  financePrincipalSchema,
  portalAccountSchema,
  portalGrantListItemSchema,
  portalGrantPerformedSchema,
  portalGrantSchema,
  portalInvitationSchema,
  type FinanceContractHotel,
  type FinanceContractSupplier,
  type FinanceContractSupplierDocument,
  type FinancePrincipal,
  type FinancePrincipalRequest,
  type PortalAccount,
  type PortalAccountRequest,
  type PortalGrant,
  type PortalGrantIssueRequest,
  type PortalGrantListItem,
  type PortalGrantRequestLookup,
  type PortalGrantPerformed,
  type PortalGrantReplaceRequest,
  type PortalInvitation,
} from '@ayvo/types';
import { z } from 'zod';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';

/** The core is unreachable, slow or answered unexpectedly: Finance fails closed (ADR 0039 §4). */
export const dependencyUnavailable = () =>
  domainError(
    503,
    'FINANCE_DEPENDENCY_UNAVAILABLE',
    'AYVO OS je dočasně nedostupný; tuto akci Financí teď nelze provést.',
  );

/**
 * Client of the core's internal Finance contract (ADR 0039 §4). Every call carries the service
 * token and the user's session token; the core evaluates the user now. GETs are retried once on
 * a network error, nothing else is ever retried. 401/403/404 of the core are the user's answer;
 * anything else (timeout, 5xx, malformed body) is "temporarily unavailable" — never a guess.
 */
@Injectable()
export class CoreClient {
  private readonly logger = new Logger(CoreClient.name);

  constructor(@Inject(FINANCE_ENV) private readonly env: FinanceEnv) {}

  principal(sessionToken: string, request: FinancePrincipalRequest): Promise<FinancePrincipal> {
    return this.json('POST', 'principal', sessionToken, financePrincipalSchema, request);
  }

  suppliers(sessionToken: string): Promise<FinanceContractSupplier[]> {
    return this.json('GET', 'suppliers', sessionToken, z.array(financeContractSupplierSchema));
  }

  /** Suppliers by id; an unknown id is simply absent. */
  async lookupSuppliers(
    sessionToken: string,
    ids: readonly string[],
  ): Promise<Map<string, FinanceContractSupplier>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.json(
      'POST',
      'suppliers/lookup',
      sessionToken,
      z.array(financeContractSupplierSchema),
      { ids: unique },
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Hotels to bill (doc 040): identity and address only. */
  hotels(sessionToken: string): Promise<FinanceContractHotel[]> {
    return this.json('GET', 'hotels', sessionToken, z.array(financeContractHotelSchema));
  }

  /** Hotels by id; an unknown id is simply absent. */
  async lookupHotels(
    sessionToken: string,
    ids: readonly string[],
  ): Promise<Map<string, FinanceContractHotel>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.json(
      'POST',
      'hotels/lookup',
      sessionToken,
      z.array(financeContractHotelSchema),
      { ids: unique },
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  supplierDocuments(
    sessionToken: string,
    supplierId?: string,
  ): Promise<FinanceContractSupplierDocument[]> {
    const q = supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : '';
    return this.json(
      'GET',
      `supplier-documents${q}`,
      sessionToken,
      z.array(financeContractSupplierDocumentSchema),
    );
  }

  supplierDocument(sessionToken: string, id: string): Promise<FinanceContractSupplierDocument> {
    return this.json(
      'GET',
      `supplier-documents/${encodeURIComponent(id)}`,
      sessionToken,
      financeContractSupplierDocumentSchema,
    );
  }

  async supplierDocumentContent(sessionToken: string, id: string): Promise<Buffer> {
    const res = await this.call(
      'GET',
      `supplier-documents/${encodeURIComponent(id)}/content`,
      sessionToken,
      undefined,
      this.env.CORE_CONTENT_TIMEOUT_MS,
    );
    return Buffer.from(await res.arrayBuffer());
  }

  // --- hotel portal grants (ADR 0045 §4): Finance → core, never the other way --------------

  /** The PORTAL account of an e-mail (created when new); a staff e-mail → EMAIL_IS_STAFF. */
  portalAccount(sessionToken: string, body: PortalAccountRequest): Promise<PortalAccount> {
    return this.json('POST', 'portal-accounts', sessionToken, portalAccountSchema, body, true);
  }

  issuePortalGrant(sessionToken: string, body: PortalGrantIssueRequest): Promise<PortalGrant> {
    return this.json('POST', 'portal-grants', sessionToken, portalGrantSchema, body, true);
  }

  replacePortalGrant(
    sessionToken: string,
    grantId: string,
    body: PortalGrantReplaceRequest,
  ): Promise<PortalGrant> {
    return this.json(
      'POST',
      `portal-grants/${encodeURIComponent(grantId)}/replace`,
      sessionToken,
      portalGrantSchema,
      body,
      true,
    );
  }

  invitePortalAccount(
    sessionToken: string,
    userId: string,
    requestId: string,
    retry = false,
  ): Promise<PortalInvitation> {
    return this.json(
      'POST',
      `portal-accounts/${encodeURIComponent(userId)}/invitation`,
      sessionToken,
      portalInvitationSchema,
      { requestId, retry },
      true,
    );
  }

  /** The stored result of a grant request the core already performed, or null (read only). */
  async performedPortalGrantRequest(
    sessionToken: string,
    body: PortalGrantRequestLookup,
  ): Promise<PortalGrantPerformed | null> {
    try {
      return await this.json(
        'POST',
        'portal-grants/requests/lookup',
        sessionToken,
        portalGrantPerformedSchema,
        body,
        true,
      );
    } catch (error) {
      const code = (error as { getResponse?: () => { code?: string } }).getResponse?.().code;
      if (code === 'REQUEST_NOT_FOUND') return null;
      throw error;
    }
  }

  portalGrant(sessionToken: string, grantId: string): Promise<PortalGrant> {
    return this.json(
      'GET',
      `portal-grants/${encodeURIComponent(grantId)}`,
      sessionToken,
      portalGrantSchema,
    );
  }

  portalGrantsOfPayer(
    sessionToken: string,
    payerCustomerId: string,
  ): Promise<PortalGrantListItem[]> {
    return this.json(
      'GET',
      `portal-grants?payerCustomerId=${encodeURIComponent(payerCustomerId)}`,
      sessionToken,
      z.array(portalGrantListItemSchema),
    );
  }

  /**
   * `domainAnswers`: the core's own refusals of a write (400 invalid, 409 its domain rule, e.g.
   * GRANT_EXISTS) are the user's answer and are passed on with their code — never retried.
   */
  private async json<T>(
    method: 'GET' | 'POST',
    path: string,
    sessionToken: string,
    schema: z.ZodType<T>,
    body?: unknown,
    domainAnswers = false,
  ): Promise<T> {
    const res = await this.call(
      method,
      path,
      sessionToken,
      body,
      this.env.CORE_TIMEOUT_MS,
      domainAnswers,
    );
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      this.logger.error(`Core contract ${path}: unexpected answer`);
      throw dependencyUnavailable();
    }
    return parsed.data;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    sessionToken: string,
    body: unknown,
    timeoutMs: number,
    domainAnswers = false,
  ): Promise<Response> {
    const url = `${this.env.CORE_INTERNAL_URL}/api/internal/v1/finance/${path}`;
    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.env.FINANCE_SERVICE_TOKEN}`,
            'x-ayvo-session': sessionToken,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch {
        if (attempt < attempts) continue;
        this.logger.warn(`Core contract ${method} ${path}: unreachable`);
        throw dependencyUnavailable();
      }
      if (res.ok) return res;
      if (res.status === 401 || res.status === 403) {
        const answer = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        if (answer.code === 'SERVICE_UNAUTHENTICATED') {
          // Our own service token is wrong: a configuration fault, not the user's sign-in.
          this.logger.error('Core contract refused the Finance service token');
          throw dependencyUnavailable();
        }
        throw domainError(
          res.status,
          answer.code ?? (res.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN'),
          answer.message ?? 'Přístup odepřen',
        );
      }
      if (res.status === 404) {
        const answer = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        if (domainAnswers && answer.code) throw domainError(404, answer.code, answer.message ?? '');
        throw new NotFoundException('Nenalezeno');
      }
      if (domainAnswers && (res.status === 400 || res.status === 409)) {
        const answer = (await res.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        if (answer.code)
          throw answer.details
            ? domainErrorWithDetails(res.status, answer.code, answer.message ?? '', answer.details)
            : domainError(res.status, answer.code, answer.message ?? '');
      }
      this.logger.warn(`Core contract ${method} ${path}: HTTP ${res.status}`);
      throw dependencyUnavailable();
    }
  }
}

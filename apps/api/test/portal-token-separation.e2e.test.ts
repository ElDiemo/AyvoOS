import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FINANCE_ENV, type FinanceEnv } from '../src/finance/finance-env.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { hasDatabase } from './support/test-app.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Doc 064 §3 (review 5847937038 (2)): the three service tokens are each accepted only on their own
 * routes — proven with every token VALID somewhere (an invalid token proves nothing). Synthetic
 * tokens, no session, nothing outside the test databases.
 *
 * - PORTAL_CORE_TOKEN    → only the core's /api/internal/v1/portal/*
 * - PORTAL_FINANCE_TOKEN → only Finance's /api/internal/v1/portal/invoices*
 * - FINANCE_SERVICE_TOKEN → only the core's /api/internal/v1/finance/*
 */
describe.skipIf(!hasDatabase)(
  'the portal and Finance service tokens are not interchangeable',
  () => {
    const portalCore = randomBytes(32).toString('base64url');
    const portalFinance = randomBytes(32).toString('base64url');
    let f: FinanceTestApp;
    let financeService: string;

    const core = () => request(f.core.app.getHttpServer());
    const finance = () => request(f.app.getHttpServer());
    /** The answer's code for a call with only this bearer token (no session). */
    const code = async (r: request.Test, token: string) => {
      const res = await r.set('Authorization', `Bearer ${token}`);
      return `${res.status} ${(res.body as { code?: string }).code ?? ''}`.trim();
    };

    beforeAll(async () => {
      f = await createFinanceTestApp({
        coreEnv: {
          PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test',
          PORTAL_SERVICE_TOKEN_SHA256: sha(portalCore),
        },
        finance: { PORTAL_FINANCE_TOKEN_SHA256: sha(portalFinance) },
      });
      financeService = f.app.get<FinanceEnv>(FINANCE_ENV).FINANCE_SERVICE_TOKEN;
    });
    afterAll(() => f?.close());

    it('a valid token passes only its own receiver; every other valid token is an unknown service', async () => {
      const routes = {
        corePortal: () => core().get('/api/internal/v1/portal/hotels'),
        financePortal: () => finance().get('/api/internal/v1/portal/invoices'),
        coreFinance: () => core().post('/api/internal/v1/finance/introspect-portal').send({}),
      };
      const owner = {
        corePortal: portalCore,
        financePortal: portalFinance,
        coreFinance: financeService,
      };
      const tokens = [portalCore, portalFinance, financeService];
      for (const [route, call] of Object.entries(routes) as [
        keyof typeof routes,
        () => request.Test,
      ][])
        for (const token of tokens)
          expect(await code(call(), token), `${route}`).toBe(
            // Its own token passes the service check and lacks only the (absent) session.
            token === owner[route] ? '401 UNAUTHENTICATED' : '401 SERVICE_UNAUTHENTICATED',
          );
    });
  },
);

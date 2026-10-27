import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  accountingExportSchema,
  bankStatusSchema,
  billingAgreementSchema,
  billingCustomerSchema,
  carrierConnectionAdminSchema,
  catalogComponentSchema,
  currentUserSchema,
  effectiveTermsPageSchema,
  financeDocumentPageSchema,
  inventoryItemSchema,
  inventoryMovementPageSchema,
  issuerSettingsSchema,
  PERMISSION_CODES,
  permissionCatalogSchema,
  pplSettingsSchema,
  roleCatalogSchema,
  stockOverviewSchema,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFinanceTestApp,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import {
  adminDatabaseUrl,
  createTestApp,
  hasDatabase,
  withPrivileged,
  type TestApp,
} from './support/test-app.js';

/**
 * Rollback check (opt-in): THIS version of the application against a database migrated by a NEWER
 * version — what a rollback of the images leaves behind. Set AYVO_NEWER_API_DIR to the newer
 * checkout's apps/api (its core and Finance migrations are applied on top of this run's test
 * database) and optionally AYVO_NEWER_SEED_SQL to rows only the newer version would create. Run
 * this file alone: it moves the shared test database to the newer schema.
 *
 *   AYVO_NEWER_API_DIR=/path/to/newer/apps/api pnpm exec vitest run test/rollback-compat.e2e.test.ts
 *
 * It then loads, as this version, the signed-in user, the administration and the main core and
 * Finance read models, parsing each answer with this version's own contracts (as its web does).
 */
const NEWER = process.env.AYVO_NEWER_API_DIR;
const SEED = process.env.AYVO_NEWER_SEED_SQL;

describe.skipIf(!hasDatabase || !NEWER)('this version against a newer database (rollback)', () => {
  let t: TestApp;
  let real: TestApp;
  let f: FinanceTestApp;
  let admin: string;

  beforeAll(async () => {
    const prisma = join(NEWER!, 'node_modules/.bin/prisma');
    execFileSync(prisma, ['migrate', 'deploy'], {
      cwd: NEWER,
      env: { ...process.env, DATABASE_URL: adminDatabaseUrl! },
      stdio: 'pipe',
    });
    execFileSync(prisma, ['migrate', 'deploy', '--config', 'prisma-finance.config.ts'], {
      cwd: NEWER,
      env: {
        ...process.env,
        FINANCE_MIGRATE_DATABASE_URL: `${financeOwnerDatabaseUrl!}?schema=finance`,
      },
      stdio: 'pipe',
    });
    t = await createTestApp();
    real = await createTestApp({}, {}, { auth: 'real' });
    f = await createFinanceTestApp();
    const user = await prepareInvitedUser(real, {
      email: `rollback-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Admin (návrat)',
    });
    await real.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'rollback check' },
    });
    admin = await sessionCookie(real, user.email);
    // One statement (e.g. a DO block), run as the privileged fixture role, after a user exists.
    if (SEED) await withPrivileged((db) => db.$executeRawUnsafe(readFileSync(SEED, 'utf8')));
  });
  afterAll(async () => {
    await t?.close();
    await real?.close();
    await f?.close();
  });

  it('the database really is newer: it holds permissions this version does not know', async () => {
    const codes = await withPrivileged(
      (db) => db.$queryRaw<{ code: string }[]>`SELECT code FROM permissions`,
    );
    const unknown = codes
      .map((c) => c.code)
      .filter((c) => !(PERMISSION_CODES as readonly string[]).includes(c));
    console.log('ROLLBACK_UNKNOWN_PERMISSIONS', JSON.stringify(unknown.sort()));
    expect(unknown.length).toBeGreaterThan(0);
  });

  it('the signed-in ADMIN (holding the newer permissions) loads', async () => {
    const me = await request(real.app.getHttpServer()).get('/api/auth/me').set('Cookie', admin);
    expect(me.status).toBe(200);
    expect(currentUserSchema.safeParse(me.body).error?.issues ?? []).toEqual([]);
  });

  const core: [string, z.ZodType][] = [
    ['/api/admin/identity/roles', roleCatalogSchema],
    ['/api/admin/identity/permissions', permissionCatalogSchema],
    ['/api/admin/inventory/items', z.array(inventoryItemSchema)],
    ['/api/admin/inventory/stock', stockOverviewSchema],
    ['/api/admin/inventory/movements', inventoryMovementPageSchema],
    ['/api/admin/catalog/components', z.array(catalogComponentSchema)],
    ['/api/admin/carrier-connections', z.array(carrierConnectionAdminSchema)],
    [`/api/admin/sites/${INITIAL_SITE_ID}/carriers/ppl`, pplSettingsSchema],
    ['/api/admin/hotels', z.unknown()],
  ];
  it.each(core)('core %s loads and matches this version’s contract', async (path, schema) => {
    const res = await request(t.app.getHttpServer()).get(path);
    expect([path, res.status]).toEqual([path, 200]);
    expect(schema.safeParse(res.body).error?.issues ?? []).toEqual([]);
  });

  const finance: [string, z.ZodType][] = [
    ['/api/admin/finance/documents', financeDocumentPageSchema],
    ['/api/admin/finance/exports', z.array(accountingExportSchema)],
    ['/api/admin/finance/billing/customers', z.array(billingCustomerSchema)],
    ['/api/admin/finance/billing/agreements', z.array(billingAgreementSchema)],
    ['/api/admin/finance/billing/agreements/effective?month=2026-10', effectiveTermsPageSchema],
    ['/api/admin/finance/issuer', issuerSettingsSchema],
    ['/api/admin/finance/bank/status', bankStatusSchema],
  ];
  it.each(finance)('Finance %s loads and matches this version’s contract', async (path, schema) => {
    const res = await f.get(path);
    expect([path, res.status]).toEqual([path, 200]);
    expect(schema.safeParse(res.body).error?.issues ?? []).toEqual([]);
  });
});

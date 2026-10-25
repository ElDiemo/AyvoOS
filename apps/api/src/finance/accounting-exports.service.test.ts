import type { AccountingExportDetail, CreateAccountingExportRequest } from '@ayvo/types';
import { describe, expect, it, vi } from 'vitest';
import { AccountingExportsService } from './accounting-exports.service.js';
import type { FinanceCaller } from './finance-access.guard.js';

/**
 * Review FIN68-R1: while an export is being built, a second request with the same requestId
 * shares that build ONLY if it is the very same request (payload and author); anything else is
 * IDEMPOTENCY_CONFLICT, and the original still completes exactly once. The build is held open,
 * so the second request really arrives while the first is in flight (no database, no storage).
 */
const caller = (userId: string): FinanceCaller => ({
  principal: {
    userId,
    displayName: 'Tester',
    permissions: ['finance:exports_manage'],
    globalSiteAccess: true,
    siteIds: [],
  },
  sessionToken: 'session',
});
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const request: CreateAccountingExportRequest = {
  requestId: '00000000-0000-4000-8000-000000000001',
  handoverMonth: '2013-05',
  mode: 'FULL',
  previewFingerprint: 'a'.repeat(64),
  note: 'first',
};
const result = { code: 'AE-000001' } as AccountingExportDetail;
/** The domain error code of a rejected call (HttpException response). */
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'fulfilled',
    (e: { getResponse?: () => { code?: string } }) => e.getResponse?.().code ?? String(e),
  );

function service() {
  const prisma = { operationRequest: { findUnique: vi.fn().mockResolvedValue(null) } };
  const svc = new AccountingExportsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  let release!: (value: AccountingExportDetail) => void;
  const build = vi.fn(() => new Promise<AccountingExportDetail>((resolve) => (release = resolve)));
  (svc as unknown as { build: typeof build }).build = build;
  return { svc, build, release: () => release(result) };
}

describe('AccountingExportsService.create while a build is in flight (FIN68-R1)', () => {
  it('the very same request shares the build; it runs once', async () => {
    const { svc, build, release } = service();
    const first = svc.create(request, caller(ALICE));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    const second = svc.create({ ...request }, caller(ALICE));
    release();
    await expect(first).resolves.toBe(result);
    await expect(second).resolves.toBe(result);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another note', { ...request, note: 'DIFFERENT PAYLOAD' }, ALICE],
    ['another mode', { ...request, mode: 'SUPPLEMENT' as const }, ALICE],
    ['another fingerprint', { ...request, previewFingerprint: 'b'.repeat(64) }, ALICE],
    ['another month', { ...request, handoverMonth: '2013-06' }, ALICE],
    ['another author', { ...request }, BOB],
  ])(
    '%s under the same requestId is a conflict; the original completes once',
    async (_, other, who) => {
      const { svc, build, release } = service();
      const first = svc.create(request, caller(ALICE));
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
      expect(await codeOf(svc.create(other, caller(who)))).toBe('IDEMPOTENCY_CONFLICT');
      release();
      await expect(first).resolves.toBe(result);
      expect(build).toHaveBeenCalledTimes(1);
    },
  );

  it('another export meanwhile is busy, not queued', async () => {
    const { svc, build, release } = service();
    const first = svc.create(request, caller(ALICE));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    expect(
      await codeOf(
        svc.create(
          { ...request, requestId: '00000000-0000-4000-8000-000000000002' },
          caller(ALICE),
        ),
      ),
    ).toBe('EXPORT_BUSY');
    release();
    await first;
    expect(build).toHaveBeenCalledTimes(1);
  });
});

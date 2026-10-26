import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateIssuerBankAccountRequest,
  DefaultAccount,
  IssuerBankAccount,
  IssuerBankAccountFields,
  IssuerBankAccountVersion,
  IssuerGap,
  IssuerSettings,
  IssuerVersion,
  NewIssuerBankAccountVersionRequest,
  NewIssuerVersionRequest,
  SetDefaultAccountRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { allocateFinanceSerial, FinanceOperations } from './finance-operations.js';
import { FinancePrismaService } from './finance-prisma.service.js';

type IssuerRow = Prisma.IssuerVersionGetPayload<object>;
type AccountVersionRow = Prisma.IssuerBankAccountVersionGetPayload<object>;
type DefaultRow = Prisma.IssuerDefaultAccountGetPayload<{ include: { account: true } }>;

const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const concurrentChange = () =>
  domainError(409, 'CONCURRENT_CHANGE', 'Údaje mezitím změnil někdo jiný. Načtěte je znovu.');

/**
 * Serializes the changes that decide which account is the default of a currency (choosing one,
 * retiring or re-currencying an account): the row of the revision counter is locked until commit
 * (the runtime role cannot lock version rows, they are append-only). No number is consumed.
 */
async function lockDefaults(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`
    SELECT "last_value" FROM "finance"."code_counters" WHERE "name" = 'billing_revision' FOR UPDATE`;
}

/**
 * Our company as the issuer of invoices and the bank accounts printed on them (N3A-2a, doc 040
 * §8). The only place these are kept. Append-only versions with author and reason; every form
 * names the version it was edited from (409 CONCURRENT_CHANGE otherwise, as review N3A74-R2).
 * Readiness lists what still blocks a LIVE invoice — development and synthetic tests never wait.
 */
@Injectable()
export class IssuerSettingsService {
  constructor(
    private readonly prisma: FinancePrismaService,
    private readonly operations: FinanceOperations,
  ) {}

  async settings(): Promise<IssuerSettings> {
    const [issuer, accounts, defaults] = await Promise.all([
      this.prisma.issuerVersion.findMany({ orderBy: { version: 'desc' } }),
      this.prisma.issuerBankAccount.findMany({
        orderBy: { serial: 'asc' },
        include: { versions: { orderBy: { version: 'desc' } } },
      }),
      this.prisma.issuerDefaultAccount.findMany({
        orderBy: { revision: 'desc' },
        include: { account: true },
      }),
    ]);
    const current = new Map<string, DefaultRow>();
    for (const d of defaults) if (!current.has(d.currency)) current.set(d.currency, d);
    const accountViews: IssuerBankAccount[] = accounts.map((a) => {
      const versions = a.versions.map(accountVersion);
      return { id: a.id, code: a.code, current: versions[0]!, versions };
    });
    const currencies = new Set<string>(['CZK', ...current.keys()]);
    for (const a of accountViews)
      if (a.current.status === 'ACTIVE') currencies.add(a.current.account.currency);
    const readiness = [...currencies].sort().map((currency) => {
      const gaps: IssuerGap[] = [];
      if (issuer.length === 0) gaps.push('ISSUER_MISSING');
      const d = current.get(currency);
      const chosen = d && accountViews.find((a) => a.id === d.accountId);
      if (!chosen) gaps.push('NO_DEFAULT_ACCOUNT');
      else if (chosen.current.status !== 'ACTIVE' || chosen.current.account.currency !== currency)
        gaps.push('DEFAULT_ACCOUNT_RETIRED');
      return { currency, gaps };
    });
    return {
      current: issuer[0] ? issuerVersion(issuer[0]) : null,
      versions: issuer.map(issuerVersion),
      accounts: accountViews,
      defaults: [...current.values()].map(defaultAccount),
      readiness,
    };
  }

  async newIssuerVersion(
    req: NewIssuerVersionRequest,
    caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'ISSUER_VERSION',
      req.requestId,
      {
        expectedVersion: req.expectedVersion,
        issuer: req.issuer,
        reason: req.reason,
        actorId: userId,
      },
      async (tx) => {
        const newest = await tx.issuerVersion.findFirst({
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        if ((newest?.version ?? 0) !== req.expectedVersion) throw concurrentChange();
        try {
          await tx.issuerVersion.create({
            data: {
              ...req.issuer,
              version: req.expectedVersion + 1,
              reason: req.reason,
              recordedBy: userId,
              recordedByName: displayName,
              requestId: req.requestId,
            },
          });
        } catch (e) {
          // Two saves from the same version at once: the primary key lets exactly one in.
          if (isUnique(e)) throw concurrentChange();
          throw e;
        }
        return { version: req.expectedVersion + 1 };
      },
    );
    return this.settings();
  }

  async createAccount(
    req: CreateIssuerBankAccountRequest,
    caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'ISSUER_ACCOUNT_CREATE',
      req.requestId,
      { account: req.account, reason: req.reason, actorId: userId },
      async (tx) => {
        const serial = await allocateFinanceSerial(tx, 'issuer_bank_account');
        const code = `IB-${String(serial).padStart(6, '0')}`;
        const created = await tx.issuerBankAccount.create({
          data: {
            serial,
            code,
            createdBy: userId,
            createdByName: displayName,
            requestId: req.requestId,
          },
        });
        await tx.issuerBankAccountVersion.create({
          data: {
            ...accountData(req.account),
            accountId: created.id,
            version: 1,
            status: 'ACTIVE',
            reason: req.reason,
            recordedBy: userId,
            recordedByName: displayName,
            requestId: req.requestId,
          },
        });
        return { code };
      },
    );
    return this.settings();
  }

  async newAccountVersion(
    code: string,
    req: NewIssuerBankAccountVersionRequest,
    caller: FinanceCaller,
  ): Promise<IssuerSettings> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'ISSUER_ACCOUNT_VERSION',
      req.requestId,
      {
        code,
        expectedVersion: req.expectedVersion,
        status: req.status,
        account: req.account,
        reason: req.reason,
        actorId: userId,
      },
      async (tx) => {
        await lockDefaults(tx);
        const a = await tx.issuerBankAccount.findUnique({
          where: { code },
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        });
        if (!a) throw new NotFoundException('Účet nenalezen');
        const newest = a.versions[0]!;
        if (newest.version !== req.expectedVersion) throw concurrentChange();
        // The default of a currency is never retired or moved to another currency silently:
        // another default is chosen first.
        const leavesDefault = req.status === 'RETIRED' || req.account.currency !== newest.currency;
        if (leavesDefault) {
          const d = await tx.issuerDefaultAccount.findFirst({
            where: { currency: newest.currency },
            orderBy: { revision: 'desc' },
          });
          if (d?.accountId === a.id)
            throw domainError(
              409,
              'ACCOUNT_IS_DEFAULT',
              'Účet je výchozí pro svou měnu. Nejdřív zvolte jiný výchozí účet.',
            );
        }
        try {
          await tx.issuerBankAccountVersion.create({
            data: {
              ...accountData(req.account),
              accountId: a.id,
              version: req.expectedVersion + 1,
              status: req.status,
              reason: req.reason,
              recordedBy: userId,
              recordedByName: displayName,
              requestId: req.requestId,
            },
          });
        } catch (e) {
          if (isUnique(e)) throw concurrentChange();
          throw e;
        }
        return { code };
      },
    );
    return this.settings();
  }

  async setDefault(req: SetDefaultAccountRequest, caller: FinanceCaller): Promise<IssuerSettings> {
    const { userId, displayName } = caller.principal;
    await this.operations.run(
      'ISSUER_DEFAULT_ACCOUNT',
      req.requestId,
      {
        currency: req.currency,
        accountCode: req.accountCode,
        expectedRevision: req.expectedRevision,
        reason: req.reason,
        actorId: userId,
      },
      async (tx) => {
        // The counter row stays locked until commit: the check below sees every committed choice.
        const revision = await allocateFinanceSerial(tx, 'billing_revision');
        const newest = await tx.issuerDefaultAccount.findFirst({
          where: { currency: req.currency },
          orderBy: { revision: 'desc' },
          select: { revision: true },
        });
        if ((newest ? Number(newest.revision) : null) !== req.expectedRevision)
          throw concurrentChange();
        const a = await tx.issuerBankAccount.findUnique({
          where: { code: req.accountCode },
          include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        });
        const v = a?.versions[0];
        if (!a || !v || v.status !== 'ACTIVE' || v.currency !== req.currency)
          throw domainError(
            422,
            'ACCOUNT_NOT_USABLE',
            'Výchozím účtem může být jen aktivní účet v této měně.',
          );
        await tx.issuerDefaultAccount.create({
          data: {
            revision,
            currency: req.currency,
            accountId: a.id,
            reason: req.reason,
            recordedBy: userId,
            recordedByName: displayName,
            requestId: req.requestId,
          },
        });
        return { revision: Number(revision) };
      },
    );
    return this.settings();
  }
}

function accountData(a: IssuerBankAccountFields) {
  return {
    label: a.label,
    currency: a.currency,
    accountPrefix: a.accountPrefix,
    accountNumber: a.accountNumber,
    bankCode: a.bankCode,
    iban: a.iban,
    bic: a.bic,
  };
}

function issuerVersion(v: IssuerRow): IssuerVersion {
  return {
    version: v.version,
    issuer: {
      legalName: v.legalName,
      addressLine1: v.addressLine1,
      addressLine2: v.addressLine2,
      postalCode: v.postalCode,
      city: v.city,
      countryCode: v.countryCode,
      companyId: v.companyId,
      vatStatus: v.vatStatus as IssuerVersion['issuer']['vatStatus'],
      vatId: v.vatId,
      registration: v.registration,
      email: v.email,
      phone: v.phone,
      web: v.web,
    },
    reason: v.reason,
    recordedAt: v.recordedAt.toISOString(),
    recordedByName: v.recordedByName,
  };
}

function accountVersion(v: AccountVersionRow): IssuerBankAccountVersion {
  return {
    version: v.version,
    status: v.status as IssuerBankAccountVersion['status'],
    account: {
      label: v.label,
      currency: v.currency,
      accountPrefix: v.accountPrefix,
      accountNumber: v.accountNumber,
      bankCode: v.bankCode,
      iban: v.iban,
      bic: v.bic,
    },
    reason: v.reason,
    recordedAt: v.recordedAt.toISOString(),
    recordedByName: v.recordedByName,
  };
}

function defaultAccount(d: DefaultRow): DefaultAccount {
  return {
    currency: d.currency,
    accountCode: d.account.code,
    revision: Number(d.revision),
    reason: d.reason,
    recordedAt: d.recordedAt.toISOString(),
    recordedByName: d.recordedByName,
  };
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  BankAccountStatus,
  BankStatus,
  BankSyncRun,
  BankSyncResult,
  BankTransaction,
  BankTransactionListQuery,
  BankTransactionPage,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { Prisma } from '../generated/finance-prisma/client.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinancePrismaService } from './finance-prisma.service.js';
import {
  BankFailure,
  certificateState,
  RbPremiumClient,
  rbPremiumConfig,
  type RbAccount,
  type RbPremiumConfig,
} from './rb-premium-client.js';
import type { BankEntry } from './rb-premium-entry.js';

type RunRow = Prisma.BankSyncRunGetPayload<object>;

/** The bank keeps the transaction list for 90 days back (`from`); we ask for at most 89. */
const MAX_DAYS_BACK = 89;
/** A new run re-reads the last days of the previous one (late postings, intraday completions). */
const OVERLAP_DAYS = 7;
/** At most this many pages per run (the bank's own maximum page is 99999). */
const MAX_PAGES = 200;
/** A run holding its slot longer than this is treated as abandoned (process ended mid-run). */
const LEASE_MS = 10 * 60_000;
const PAGE_SIZE = 50;

const day = (d: Date) => d.toISOString().slice(0, 10);
/** Today in Prague (the bank's day boundaries are CET/CEST). */
const pragueToday = (now: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return day(d);
};

/**
 * Reading the company's bank transactions (N3B-1, doc 041): read only, one account × currency at
 * a time (a slot claimed by a short conditional UPDATE — never a transaction held open while the
 * bank is called), all pages of the window first, then stored in ONE transaction: a run either
 * stores the whole window or nothing. Reading the same window again never duplicates an entry
 * (unique bank reference); different content for a known reference is a new version. Every
 * failure ends the run as FAILED with a code the ADMIN sees — a bank outage is never hidden.
 */
@Injectable()
export class BankSyncService {
  private readonly logger = new Logger(BankSyncService.name);
  private readonly cfg: RbPremiumConfig | null;

  constructor(
    private readonly prisma: FinancePrismaService,
    @Inject(FINANCE_ENV) env: FinanceEnv,
  ) {
    this.cfg = rbPremiumConfig(env);
  }

  async status(): Promise<BankStatus> {
    const cfg = this.cfg;
    const accounts: BankAccountStatus[] = [];
    for (const a of cfg?.accounts ?? []) {
      const where = {
        environment: cfg!.environment,
        accountNumber: a.accountNumber,
        currency: a.currency,
      };
      const [lastRun, lastSuccess] = await Promise.all([
        this.prisma.bankSyncRun.findFirst({ where, orderBy: { startedAt: 'desc' } }),
        this.prisma.bankSyncRun.findFirst({
          where: { ...where, status: 'SUCCEEDED' },
          orderBy: { startedAt: 'desc' },
        }),
      ]);
      accounts.push({
        accountNumber: a.accountNumber,
        currency: a.currency,
        lastRun: lastRun ? run(lastRun) : null,
        lastSuccess: lastSuccess ? run(lastSuccess) : null,
      });
    }
    const recent = await this.prisma.bankSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
    return {
      provider: 'RB_PREMIUM',
      environment: cfg?.environment ?? null,
      certificate: certificateState(cfg),
      accounts,
      recentRuns: recent.map(run),
    };
  }

  /** Reads every configured account, one after another; each ends as its own run. */
  async sync(caller: FinanceCaller): Promise<BankSyncResult> {
    const cfg = this.cfg;
    if (!cfg)
      throw domainError(
        409,
        'BANK_NOT_CONFIGURED',
        'Propojení s bankou není v této instalaci nastaveno.',
      );
    const runs: BankSyncRun[] = [];
    for (const account of cfg.accounts) runs.push(await this.syncAccount(cfg, account, caller));
    return { runs };
  }

  private async syncAccount(
    cfg: RbPremiumConfig,
    account: RbAccount,
    caller: FinanceCaller,
  ): Promise<BankSyncRun> {
    const started = await this.claim(cfg, account, caller);
    // Everything this run reads is bounded before it is kept: bytes and entries of the whole
    // window (N3B75-R1).
    try {
      const entries: BankEntry[] = [];
      let pages = 0;
      let bytes = 0;
      const client = new RbPremiumClient(cfg);
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES)
          throw new BankFailure(
            'TOO_MANY_PAGES',
            `Více než ${MAX_PAGES} stran pohybů v jednom načtení; nic nebylo uloženo.`,
          );
        const res = await client.transactions(
          account,
          day(started.fromDate),
          day(started.toDate),
          page,
          { maxBytes: cfg.maxWindowBytes - bytes },
        );
        bytes += res.bytes;
        if (entries.length + res.entries.length > cfg.maxWindowEntries)
          throw new BankFailure(
            'TOO_MUCH_DATA',
            `Více než ${cfg.maxWindowEntries} pohybů v jednom načtení; nic nebylo uloženo.`,
          );
        pages = page;
        entries.push(...res.entries);
        if (res.lastPage) break;
      }
      return run(await this.store(cfg, started, entries, pages));
    } catch (e) {
      const failure =
        e instanceof BankFailure
          ? e
          : new BankFailure('UNEXPECTED_RESPONSE', 'Načtení selhalo neočekávanou chybou.');
      if (!(e instanceof BankFailure)) this.logger.error(`Bank run ${started.id} failed`, e);
      return run(
        await this.finish(started.id, 'FAILED', {
          errorCode: failure.code,
          errorDetail: failure.detail,
        }),
      );
    }
  }

  /**
   * Starts a run holding the account's slot: the slot is free, or held by a run started more than
   * LEASE_MS ago (that run is finished as ABANDONED). Another live run → 409, nothing written.
   */
  private async claim(
    cfg: RbPremiumConfig,
    account: RbAccount,
    caller: FinanceCaller,
  ): Promise<RunRow> {
    const key = {
      environment: cfg.environment,
      accountNumber: account.accountNumber,
      currency: account.currency,
    };
    const lastSuccess = await this.prisma.bankSyncRun.findFirst({
      where: { ...key, status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
    });
    const today = pragueToday(new Date());
    const oldest = addDays(today, -MAX_DAYS_BACK);
    const resume = lastSuccess ? addDays(day(lastSuccess.toDate), -OVERLAP_DAYS) : oldest;
    const fromDate = resume > oldest ? resume : oldest;
    return this.prisma.$transaction(async (tx) => {
      await tx.bankSyncSlot.createMany({ data: [key], skipDuplicates: true });
      const [slot] = await tx.$queryRaw<
        { running_run_id: string | null; claimed_at: Date | null }[]
      >`
        SELECT "running_run_id", "claimed_at" FROM "finance"."bank_sync_slots"
        WHERE "environment" = ${key.environment} AND "account_number" = ${key.accountNumber}
          AND "currency" = ${key.currency}
        FOR UPDATE`;
      if (slot?.running_run_id) {
        if (slot.claimed_at && Date.now() - slot.claimed_at.getTime() < LEASE_MS)
          throw domainError(
            409,
            'BANK_SYNC_RUNNING',
            'Pohyby tohoto účtu se právě načítají. Počkejte na dokončení.',
          );
        await tx.bankSyncRun.update({
          where: { id: slot.running_run_id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorCode: 'ABANDONED',
            errorDetail: 'Načítání bylo přerušeno (např. restart); nic z něj nebylo uloženo.',
          },
        });
      }
      const created = await tx.bankSyncRun.create({
        data: {
          ...key,
          provider: 'RB_PREMIUM',
          fromDate: new Date(`${fromDate}T00:00:00.000Z`),
          toDate: new Date(`${today}T00:00:00.000Z`),
          startedBy: caller.principal.userId,
          startedByName: caller.principal.displayName,
        },
      });
      await tx.bankSyncSlot.update({
        where: { environment_accountNumber_currency: key },
        data: { runningRunId: created.id, claimedAt: created.startedAt },
      });
      return created;
    });
  }

  /** The whole window in one transaction: new entries, new versions of changed ones, the run, the slot. */
  private async store(
    cfg: RbPremiumConfig,
    started: RunRow,
    entries: BankEntry[],
    pages: number,
  ): Promise<RunRow> {
    // The same entry may come twice when the list shifts between pages: identical = once; a
    // different content within one run is kept in the order received.
    const byRef = new Map<string, BankEntry[]>();
    for (const e of entries) {
      const list = byRef.get(e.entryReference) ?? [];
      if (!list.some((x) => x.contentSha256 === e.contentSha256)) list.push(e);
      byRef.set(e.entryReference, list);
    }
    const key = {
      environment: cfg.environment,
      accountNumber: started.accountNumber,
      currency: started.currency,
    };
    return this.prisma.$transaction(
      async (tx) => {
        let created = 0;
        let changed = 0;
        for (const [entryReference, versions] of byRef) {
          await tx.bankTransaction.createMany({
            data: [{ ...key, entryReference, firstRunId: started.id }],
            skipDuplicates: true,
          });
          const t = await tx.bankTransaction.findUniqueOrThrow({
            where: {
              environment_accountNumber_currency_entryReference: { ...key, entryReference },
            },
            include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
          });
          let latest = t.versions[0] ?? null;
          for (const e of versions) {
            if (latest?.contentSha256 === e.contentSha256) continue;
            if (latest) changed++;
            else created++;
            latest = await tx.bankTransactionVersion.create({
              data: versionData(t.id, (latest?.version ?? 0) + 1, started.id, e),
            });
          }
        }
        return this.finishIn(tx, started.id, 'SUCCEEDED', {
          pages,
          received: entries.length,
          newCount: created,
          changedCount: changed,
        });
      },
      { maxWait: 20_000, timeout: 120_000 },
    );
  }

  private finish(
    id: string,
    status: 'SUCCEEDED' | 'FAILED',
    data: Prisma.BankSyncRunUpdateInput,
  ): Promise<RunRow> {
    return this.prisma.$transaction((tx) => this.finishIn(tx, id, status, data));
  }

  private async finishIn(
    tx: Prisma.TransactionClient,
    id: string,
    status: 'SUCCEEDED' | 'FAILED',
    data: Prisma.BankSyncRunUpdateInput,
  ): Promise<RunRow> {
    const done = await tx.bankSyncRun.update({
      where: { id },
      data: { ...data, status, finishedAt: new Date() },
    });
    await tx.bankSyncSlot.updateMany({
      where: { runningRunId: id },
      data: { runningRunId: null, claimedAt: null },
    });
    return done;
  }

  /** The newest version of each entry, newest booking first. */
  async transactions(q: BankTransactionListQuery): Promise<BankTransactionPage> {
    const [accountNumber, currency] = q.account?.split('/') ?? [];
    const filters: Prisma.Sql[] = [];
    if (accountNumber) filters.push(Prisma.sql`t."account_number" = ${accountNumber}`);
    if (currency) filters.push(Prisma.sql`t."currency" = ${currency}`);
    if (q.direction) filters.push(Prisma.sql`v."credit_debit" = ${q.direction}`);
    const when = Prisma.sql`COALESCE(v."booking_date", v."value_date", t."first_seen_at")`;
    if (q.from)
      filters.push(Prisma.sql`(${when} AT TIME ZONE 'Europe/Prague')::date >= ${q.from}::date`);
    if (q.to)
      filters.push(Prisma.sql`(${when} AT TIME ZONE 'Europe/Prague')::date <= ${q.to}::date`);
    const where = filters.length
      ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
      : Prisma.empty;
    const current = Prisma.sql`
      SELECT DISTINCT ON (v."transaction_id") v.* FROM "finance"."bank_transaction_versions" v
      ORDER BY v."transaction_id", v."version" DESC`;
    const [count] = await this.prisma.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total FROM "finance"."bank_transactions" t
      JOIN (${current}) v ON v."transaction_id" = t."id" ${where}`;
    const rows = await this.prisma.$queryRaw<ListRow[]>`
      SELECT t."id", t."environment", t."account_number", t."currency", t."entry_reference",
             t."first_seen_at", v."version", v."amount"::text AS "amount", v."amount_currency",
             v."credit_debit", v."booking_date", v."value_date", v."bank_transaction_code",
             v."counterparty_name", v."counterparty_account_prefix",
             v."counterparty_account_number", v."counterparty_bank_code", v."counterparty_iban",
             v."variable_symbol", v."constant_symbol", v."specific_symbol", v."message"
      FROM "finance"."bank_transactions" t
      JOIN (${current}) v ON v."transaction_id" = t."id" ${where}
      ORDER BY ${when} DESC, t."entry_reference" DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`;
    return {
      items: rows.map(transaction),
      page: q.page,
      pageSize: PAGE_SIZE,
      total: count?.total ?? 0,
    };
  }
}

interface ListRow {
  id: string;
  environment: BankTransaction['environment'];
  account_number: string;
  currency: string;
  entry_reference: string;
  first_seen_at: Date;
  version: number;
  amount: string;
  amount_currency: string;
  credit_debit: 'CRDT' | 'DBIT';
  booking_date: Date | null;
  value_date: Date | null;
  bank_transaction_code: string;
  counterparty_name: string | null;
  counterparty_account_prefix: string | null;
  counterparty_account_number: string | null;
  counterparty_bank_code: string | null;
  counterparty_iban: string | null;
  variable_symbol: string | null;
  constant_symbol: string | null;
  specific_symbol: string | null;
  message: string | null;
}

function versionData(
  transactionId: string,
  version: number,
  runId: string,
  e: BankEntry,
): Prisma.BankTransactionVersionUncheckedCreateInput {
  return {
    transactionId,
    version,
    runId,
    contentSha256: e.contentSha256,
    amount: new Prisma.Decimal(e.amount),
    amountCurrency: e.amountCurrency,
    creditDebit: e.creditDebit,
    bookingDate: e.bookingDate,
    valueDate: e.valueDate,
    bankTransactionCode: e.bankTransactionCode,
    endToEndId: e.endToEndId,
    counterpartyName: e.counterpartyName,
    counterpartyAccountPrefix: e.counterpartyAccountPrefix,
    counterpartyAccountNumber: e.counterpartyAccountNumber,
    counterpartyBankCode: e.counterpartyBankCode,
    counterpartyIban: e.counterpartyIban,
    variableSymbol: e.variableSymbol,
    constantSymbol: e.constantSymbol,
    specificSymbol: e.specificSymbol,
    message: e.message,
    originatorMessage: e.originatorMessage,
    instructedAmount: e.instructedAmount === null ? null : new Prisma.Decimal(e.instructedAmount),
    instructedCurrency: e.instructedCurrency,
    raw: e.raw,
  };
}

function run(r: RunRow): BankSyncRun {
  return {
    id: r.id,
    environment: r.environment as BankSyncRun['environment'],
    accountNumber: r.accountNumber,
    currency: r.currency,
    fromDate: day(r.fromDate),
    toDate: day(r.toDate),
    status: r.status as BankSyncRun['status'],
    startedAt: r.startedAt.toISOString(),
    startedByName: r.startedByName,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    pages: r.pages,
    received: r.received,
    newCount: r.newCount,
    changedCount: r.changedCount,
    errorCode: r.errorCode as BankSyncRun['errorCode'],
    errorDetail: r.errorDetail,
  };
}

function account(prefix: string | null, number: string | null, bank: string | null) {
  if (!number) return null;
  const n = prefix && /[1-9]/.test(prefix) ? `${prefix.replace(/^0+/, '')}-${number}` : number;
  return bank ? `${n}/${bank}` : n;
}

function transaction(r: ListRow): BankTransaction {
  return {
    id: r.id,
    environment: r.environment,
    accountNumber: r.account_number,
    currency: r.currency,
    entryReference: r.entry_reference,
    version: r.version,
    amount: r.amount,
    amountCurrency: r.amount_currency,
    creditDebit: r.credit_debit,
    bookingDate: r.booking_date?.toISOString() ?? null,
    valueDate: r.value_date?.toISOString() ?? null,
    bankTransactionCode: r.bank_transaction_code,
    counterparty: {
      name: r.counterparty_name,
      account: account(
        r.counterparty_account_prefix,
        r.counterparty_account_number,
        r.counterparty_bank_code,
      ),
      iban: r.counterparty_iban,
    },
    variableSymbol: r.variable_symbol,
    constantSymbol: r.constant_symbol,
    specificSymbol: r.specific_symbol,
    message: r.message,
    processing: 'NOT_PAIRED',
    firstSeenAt: r.first_seen_at.toISOString(),
  };
}

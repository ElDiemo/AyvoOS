# 041 — Finance: bank transactions from Raiffeisenbank Premium API (N3B-1)

- **Status:** implemented for review — not merged, not deployed, no live bank call made. Owner
  prioritised payments on 2026-10-26 (`N3B-RB-PRIORITA-20261026.md`). The production app, its
  ClientID and the Premium API subscription exist at the bank; the certificate stays with the owner.
- **Scope:** read the company account's transactions, show them in Finance → Bankovní pohyby with
  the state of the connection. **Not** in scope: pairing with invoices (needs the issued-invoice
  model, N3A-2), payment orders or batches, statements, balances, scheduled reads, certificate
  upload through the web. The invoice recipient account (N3 "Naše firma a bankovní účty") is a
  separate setting, never this connection.

## 1. The bank's contract (verified)

Source: the Swagger definitions embedded in developers.rb.cz (Production and Sandbox, version
1.1.20240910, read 2026-10-26). Used operation only:

`GET https://api.rb.cz/rbcz/premium/api/accounts/{accountNumber}/{currencyCode}/transactions`
(sandbox `…/rbcz/premium/mock/…`).

- Account number national, digits only, without prefix or bank code; currency e.g. `CZK`.
- Query `from`, `to` (date, CET day boundaries), `page` (1…99999). `from` at most 90 days back,
  otherwise 400 `DT01`.
- Headers `X-IBM-Client-Id` (the app's ClientID) and `X-Request-Id` (≤ 60 chars); mTLS with the
  client certificate issued in internet banking (PKCS#12 + password).
- 200 `{ lastPage, transactions[] }`, 204 = non-existing page / empty; 401 certificate missing or
  invalid; 403 `INSUFFICIENT_RIGHTS`; 404 `ID_NOT_FOUND`; 429 `TOO_MANY_REQUESTS`; undocumented
  5xx possible. Limits (production): 10 requests/s and 5 000/day per client.
- Entry: required `entryReference` ("unique identification of the realized transaction"),
  `amount {value (JSON number, double), currency}`, `creditDebitIndication` (CRDT/DBIT),
  `bankTransactionCode.code`; optional booking/value date, end-to-end id, counterparty (name,
  account prefix/number/IBAN, bank code), remittance (`unstructured`, `variable`, `constant`,
  `specific`), `originatorMessage`, instructed amount.
- The contract has **no** reversal/storno flag and does not say whether an intraday entry keeps its
  `entryReference` when posted. Both are handled without assumptions (§2) and must be verified with
  the sandbox and the first real reads (§7).

## 2. Data (schema `finance`, append-only)

| Table                       | What                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `bank_sync_runs`            | One read of one account × currency over a date window: who, when, window, RUNNING → SUCCEEDED / FAILED + code, exactly once |
| `bank_sync_slots`           | Which run currently reads an account × currency (no overlapping runs; current state)                                        |
| `bank_transactions`         | A bank entry once per (environment, account, currency, `entryReference`)                                                    |
| `bank_transaction_versions` | Its content as sent; different later content = a new version, nothing overwritten                                           |

- Amounts `NUMERIC(19,2)`, read from the exact text of the answer (JSON source text), never through
  a float; more than 2 significant decimals fails the run (never rounded). The entry is kept as
  canonical JSON text (sorted keys, numbers as sent) with its SHA-256.
- Environment `PRODUCTION | SANDBOX | TEST` is part of every key: simulated or sandbox data can never
  mix with real data, and the page labels it.
- A reversal is whatever the bank sends (e.g. an opposite entry) — stored as it is, never derived.
- Triggers: entries and versions never UPDATE/DELETE/TRUNCATE (also the schema owner); a run is
  finished once and its request never changes; nothing is deleted. The runtime role has SELECT +
  INSERT (+ UPDATE on runs/slots under the trigger).

## 3. A read

1. Claim the slot (short transaction, `FOR UPDATE` on one row): free, or held by a run started more
   than 10 min ago (that one becomes FAILED `ABANDONED`). Another live run → 409 `BANK_SYNC_RUNNING`.
2. Window: first read 89 days back; later reads from the last successful window's end minus 7 days
   (late postings, intraday completions), never more than 89 days; up to today (Prague).
3. All pages (≤ 200) are read first — each request ≤ `RB_PREMIUM_TIMEOUT_MS` (15 s), 10 MB; 429 /
   5xx / timeout / network retried at most twice (1 s, 2 s). Then **one** transaction stores the
   whole window: new entries, new versions, the finished run, the free slot. A failure anywhere →
   FAILED with a code and a short secret-free reason, nothing of the window stored.
4. Errors: `CERTIFICATE_UNUSABLE` (file/password), `CERTIFICATE_REJECTED` (401 / TLS alert),
   `INSUFFICIENT_RIGHTS` (403), `ACCOUNT_NOT_FOUND` (404), `REQUEST_REJECTED` (400), `RATE_LIMITED`,
   `BANK_UNAVAILABLE`, `UNEXPECTED_RESPONSE`, `TOO_MANY_PAGES`, `ABANDONED`. A connection reset is
   reported as unavailable — never guessed to be the certificate.

Bounds of one run (reviews N3B75-R1/R2):

- **Memory:** the answers of a window together may hold at most `RB_PREMIUM_MAX_WINDOW_BYTES` (32 MiB) and `RB_PREMIUM_MAX_WINDOW_ENTRIES` (20 000). Each answer is read only up to what is left of the window budget. Exceeded → FAILED `TOO_MUCH_DATA`, nothing stored.
- **Time:** all requests, pauses and retries of a run end by `RB_PREMIUM_RUN_DEADLINE_MS` (5 min, at most 6). Exceeded → FAILED `RUN_TIMEOUT`. Together with storing (≤ 2 min) this stays inside the 10-minute lease, so a live run is not taken over.
- **Fencing:** should a run be taken over anyway, it checks its slot before every page and locks it in the storing and finishing transaction. A stale run asks the bank nothing more and writes nothing; it stays ABANDONED.

Reads are started by a person (`finance:bank_sync`); a schedule is a later, separate decision.

## 4. API (Finance unit, `/api/admin/finance/bank`)

| Method | Path                                                                                                  | Permission                                |
| ------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| GET    | `/status` — environment, certificate readable + expiry, accounts with last run / success, recent runs | `finance:bank_read`                       |
| GET    | `/transactions?account=N/CUR&direction&from&to&page` — newest version of each entry, 50 per page      | `finance:bank_read`                       |
| POST   | `/sync` `{}` — read every configured account now, one run each                                        | `finance:bank_read` + `finance:bank_sync` |

No answer contains the ClientID, the certificate, its password or file paths. `processing` is
`NOT_PAIRED` for every entry until pairing exists; an unpaired payment is not an overdue receivable.

## 5. Configuration (Finance process only)

| Variable                                                                             | Meaning                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RB_PREMIUM_ENVIRONMENT`                                                             | unset = no connection; `production` only with APP_ENV=production (and only it there); `sandbox` (dev/test); `test` = local simulation, APP_ENV=test only |
| `RB_PREMIUM_CLIENT_ID_FILE`, `RB_PREMIUM_P12_FILE`, `RB_PREMIUM_P12_PASSPHRASE_FILE` | **paths** to read-only mounted files — never the values in the env                                                                                       |
| `RB_PREMIUM_ACCOUNTS`                                                                | `number:CUR[,…]` (not secret)                                                                                                                            |
| `RB_PREMIUM_TIMEOUT_MS`, `RB_PREMIUM_RETRY_BASE_MS`                                  | bounds (15 000 / 1 000 ms)                                                                                                                               |
| `RB_PREMIUM_BASE_URL_FOR_TESTS`, `RB_PREMIUM_CA_FILE_FOR_TESTS`                      | the simulation only, refused unless APP_ENV=test                                                                                                         |

The installation runbook (who stores what where, checks, revocation) is outside the repository and
reviewed separately; the production ClientID and certificate are never placed on DEV.

## 6. Tests

- API (`test/finance-bank.e2e.test.ts`, real DB/roles/core, simulated bank over real mTLS —
  `test/support/fake-rb.ts`, its own CA per run): pages, exact amounts (`1500.50`, `-1668.59`, `0.1`,
  17+2 digits), symbols with leading zeros, no duplicates on a repeated read, overlap window,
  changed entry → version 2, 429 / 5xx / hang retried then FAILED, page 2 failing stores nothing,
  wrong password, foreign certificate (401), blocked certificate, rights removed (403), unknown
  account, >2 decimals and non-JSON refused, concurrent read 409, abandoned run taken over,
  append-only for owner and runtime, permissions with real sessions, configuration rules, no secret
  in answers.
- Unit (`src/finance/rb-premium-entry.test.ts`): exact money, canonical hash, documented nesting.
- Browser (`e2e/workflow-finance-bank.spec.ts`): the simulated connection labelled, read, exact
  display, second read adds nothing, filter, phones without sideways scrolling, refused without the
  permission; screenshots in `docs/screenshots/finance/finance-bank-*.png`.

## 7. Open before a live read

1. Sandbox read with a sandbox ClientID (the sandbox certificate is public) to confirm the real
   answer shape against the parser.
2. The owner confirms the certificate's rights (only this account, transactions + accounts/balance,
   no payments/statements), its expiry and the yearly unblocking, the tariff/fees, and how to
   revoke the certificate and the app at the bank.
3. Finance on PROD at all (Compose service, egress to `api.rb.cz` only, mounted secret files) is its
   own deployment plan with checks and rollback, approved by the owner and done by Codex.
4. First real read with the owner present; compare with internet banking (count, amounts, VS).
5. Pairing rules (account, VS, amount, currency; ambiguous cases by hand; partial and over-payments
   traceable) are implemented on the issued-invoice model, not here.

## 8. Incoming payments and the payment state of invoices (N3B-2, owner 2026-10-27)

The end of the DEV billing chain (doc 040 §9: TEST invoice → payment → state). Nothing here calls
the bank: payments are made from what was already read, or simulated outside production.

- **Sources, each recorded once** (`incoming_payments`, UNIQUE (source, source_key)):
  - `BANK` — a credit bank transaction already read (key = the transaction; its newest version
    when first recorded): Finance → Platby → "Načíst platby z bankovních pohybů";
  - `SIMULATION` — a simulated statement outside production (`APP_ENV≠production`), each entry
    with its own reference.

  Loading the same transactions or the same statement again records nothing and counts nothing
  twice (the result says how many were loaded before). Loads run one at a time.

- **Matching, deterministic** (stored as `match_result` when recorded): automatically only on an
  **exact variable symbol** (leading zeros of a bank VS ignored) of **one** invoice that is not
  cancelled, in the same currency, with an allowed environment (a TEST invoice never takes a
  PRODUCTION payment), and only up to its remaining amount — a rest stays on the payment
  (`PARTIAL_OVERPAYMENT`). Everything else waits for a person with its reason:
  `NO_VARIABLE_SYMBOL`, `UNKNOWN_VARIABLE_SYMBOL`, `CURRENCY_MISMATCH`, `ENVIRONMENT_MISMATCH`,
  `INVOICE_CANCELLED`, `INVOICE_ALREADY_PAID`. Open invoices whose remaining amount equals the
  unallocated amount are shown as a **suggestion** — never applied by themselves.
- **By hand:** `POST /api/admin/finance/payments/:code/allocations` with a reason.
- **State (derived):** a payment is unallocated / partially / allocated; an invoice unpaid /
  partially paid / paid (+ "po splatnosti" past its due date).
- **DB:** payments and allocations append-only; an allocation never exceeds the payment's or the
  invoice's remaining amount, never pays a cancelled invoice or a TEST invoice with a production
  payment; an invoice with payments is not cancelled.
- **Permissions:** reading with `finance:invoices_read`; recording, simulating and allocating with
  `finance:payments_manage` (ADMIN only).
- **Changed at the bank later:** a newer version of a recorded transaction is **never applied** —
  the recorded payment and its allocations stay as they were; the import reports it
  (`changedAtBank`) and the payment shows "Banka tento pohyb po zaznamenání změnila". **What to do
  then is an open owner/accountant decision** (not invented).
- Not covered: refunds or offsetting an overpayment (an open decision), live invoices.

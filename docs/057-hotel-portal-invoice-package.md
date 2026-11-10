# Hotel portal: invoice package for a period

This implements the requirement of doc 040 §14 (owner 2026-11-02) that was still missing from the
portal: for a chosen period and among their allowed invoices, the customer downloads a ZIP with
the PDFs and a short overview.

## Rules

- **The same visibility predicate** as the list, the detail and the PDF (`visibleInvoice`,
  ADR 0045 §5). An invoice is included when one active grant covers it whole: the grant names its
  payer and every hotel of the invoice. A summary invoice over several hotels is included **once**,
  and only for a grant covering all its hotels. Hotels of two grants are never combined.
- **The period** is the billed month, from `from` to `to` (YYYY-MM), at most 12 months, with
  `from` not after `to`. It is checked in portal-web and again in Finance.
- **The content** of the ZIP:
  - `manifest.csv`: UTF-8 with BOM, `;`, CRLF, protected against CSV injection. Columns: number,
    kind, issued, due, period, total, currency, payment state, paid, remaining, cancelled, hotels,
    file and SHA-256.
  - `README.txt`. It says that TEST invoices are not tax documents.
  - `faktury/<number>.pdf`: each PDF exactly as issued, its SHA-256 checked against the one
    recorded at issue.
- **Bounds** (Finance env):
  - `FINANCE_PORTAL_PACKAGE_MAX_INVOICES` (default 60) and `FINANCE_PORTAL_PACKAGE_MAX_BYTES`
    (default and maximum 40 MiB): the PDFs' read budget and the size of the finished ZIP,
    headers, manifest and README included, checked before a byte is sent. Exceeding either
    answers `422 PACKAGE_TOO_LARGE`, nothing sent.
  - `FINANCE_PORTAL_PACKAGE_TIMEOUT_MS` (default and maximum 60 s) for reading, packing and
    sending.
  - One fixed ceiling shared with portal-web (`PORTAL_PACKAGE_MAX_ZIP_BYTES`,
    `PORTAL_PACKAGE_MAX_MS` in `@ayvo/types`, review 5845096918): Finance may be set lower, never
    higher, so portal-web never cuts a package a supported setting produces.
  - One package at a time per process; otherwise `503 PACKAGE_BUSY`.
  - The query ends before any file is read: no DB transaction is open while packing.
- **An empty period** answers `404 NO_INVOICES`.

## Routes

- **Finance:** `GET /api/internal/v1/portal/invoices/package?from=&to=`. It takes portal-web's
  token and the forwarded session, introspected at the core. It is sent with `application/zip`,
  `private, no-store`, `nosniff` and the name `AYVO-faktury-<from>-<to>.zip`.
- **portal-web:** `GET /invoices/package?from=&to=`. It uses the same pass-through as the PDFs:
  one deadline of Finance's maximum + 5 s (65 s), counted bytes up to the shared 40 MiB ceiling,
  header checks, and it is outside the CSP proxy.
  When the period is refused (invalid, empty, too large, busy), the user is sent back to
  "Faktury" with the reason.
- **"Faktury" page:** a "Balíček za období" form with two month fields (the last three months by
  default).

## For the owner

The bounds (12 months, 60 invoices, 40 MB) are a proposal. They can be changed in Finance's env
without a code change.

# 045 — Návrhy smluv (ruční generátor)

Status: proposed for review (owner 2026-11-03). Architecture: ADR 0043. Not deployed.

## 1. Scope

A salesperson or an administrator prepares a **contract proposal** by hand from a prospect or from a
hotel's card, saves it, downloads a printable PDF, edits it or removes it while unsigned, and
uploads the already signed PDF. The PDF is generated from one versioned **Czech B2B working
template**, marked "NÁVRH – K PRÁVNÍ KONTROLE" on every page.

Not in scope:

- automatic generation of any kind;
- creating a hotel;
- any change of billing terms or anything else in Finance;
- sending, e-signatures and signature verification;
- a legally approved template;
- other languages.

## 2. Flow

1. **Připravit návrh smlouvy**:
   - from a prospect's detail (`/sales/prospects/AKV-…`, only within the prospect's scope);
   - from a hotel's card (`/hotels/HT-…`, `sales:manage` + `hotels:read`).

   Nothing is written until **Uložit návrh**.

2. **Prefill:**
   - from the prospect: name, address, rooms estimate;
   - from the hotel: name and delivery address.

   Everything stays editable. Empty means not filled in; nothing is assumed.

3. **Wizard fields:**
   - counterparty: legal name, IČO, registered address, representative (name and role);
   - hotel: name and address;
   - rooms;
   - price per room and month **without VAT** (exact, at most 2 decimals) and the currency;
   - start date;
   - billing (`ADVANCE` / `ARREARS`, as in Finance);
   - payment terms in days;
   - holders: **Bez držáků** / **S držáky**.
     - With holders, a separate required choice: **Zůstávají ve vlastnictví AYVO** / **Přejdou do
       vlastnictví zákazníka**.
     - Without holders the choice is hidden, and a value picked before is cleared.
     - The server refuses a mismatch (`HOLDERS_OWNERSHIP_MISMATCH`); the database holds it too.
   - hotel link: optional. It is chosen by hand from existing hotels (`sales:manage` +
     `hotels:read`), prefilled when opened from a hotel and written only on save.
   - a reason for each change after the first save.
4. **Check before saving:** the wizard shows a summary of all fields and the template version.
   Missing required fields are named.
5. **After saving:** the draft page shows:
   - the current revision and the download of its PDF;
   - the history of revisions and events;
   - Upravit (a new revision);
   - Odstranit nepodepsaný návrh (confirmation and a reason; restorable);
   - Připojit k hotelu, or Opravit vazbu na hotel for an unsigned draft (an audited event with
     the reason, from → to; never unlinked).
6. **The signed original:**
   - Upload of the already signed PDF to the current revision, with the signed date. That
     revision is then locked.
   - The original can be downloaded through the API, with the access check and an event.
   - It cannot be removed or replaced.
   - A later change is a new revision (an amendment proposal); the signed one stays as it was.

## 3. Data (core schema, module `contracts`)

| Table                       | Kind                         | Content                                                                                                                        |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `contract_drafts`           | current state (+ `revision`) | code `SN-000001`, prospect (nullable), hotel (nullable; at least one), template version, removed at/by/reason, created/updated |
| `contract_draft_revisions`  | append-only                  | draft, revision, every wizard field, template version, reason, author, time                                                    |
| `contract_draft_events`     | append-only                  | draft, kind, revision, actor, time, reason, details (JSON, no file content)                                                    |
| `contract_signed_documents` | append-only                  | draft, revision (unique per draft and revision), storage key, SHA-256, size, original name, signed date, uploader, time        |

Rules held by the database:

- Revisions, events and signed documents are never updated or deleted.
- A draft always has a prospect or a hotel.
- The holder ownership is set exactly when the holders are `WITH`.
- The price is `> 0` with `scale <= 2`, a numeric without typmod, so a third decimal is refused,
  not rounded.
- Rooms are 1–100000.
- A removed draft takes no new revision, hotel link or upload until restored.
- A linked hotel is never removed; its link is corrected only to another existing hotel.
- **The hotel written in the draft (and its PDF) is the linked hotel** — the same name and
  address, ignoring case and spacing. Otherwise linking, creating at a hotel or a new revision is
  refused (`HOTEL_IDENTITY_MISMATCH`, naming both) unless the difference is acknowledged
  explicitly. The UI shows both identities side by side, and the draft page says when the current
  revision differs from the linked hotel.
- A draft with a signed original is never removed.
- A signed revision is never superseded silently: a new revision after signing is allowed and
  recorded as an amendment proposal.

## 4. Access (ADR 0043 §3)

| Action                                                  | Rule                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| prepare, save, read, PDF, edit, remove, restore, upload | the draft's prospect is in the caller's sales scope; or `sales:manage` + `hotels:read` for a hotel-only draft |
| link a hotel, the block on a hotel's card               | `sales:manage` + `hotels:read`                                                                                |

Out of scope it is 404, never "forbidden for this draft".

## 5. API (`/api/admin/contracts`)

- `GET drafts?prospect=AKV-…|hotel=HT-…` lists the drafts in scope.
- `POST drafts` creates a draft (requestId, prospect or hotel, fields).
- `GET drafts/:code` returns the current state, revisions, events and the signed original's
  metadata.
- `POST drafts/:code/revisions` saves a new revision (`expectedVersion`, reason, fields).
- `POST drafts/:code/remove` and `POST drafts/:code/restore` need `expectedVersion`, a reason and
  `confirm: true`.
- `POST drafts/:code/hotel` links a hotel or corrects the link (`expectedVersion`, hotel, reason,
  `acknowledgeMismatch`).
- `GET drafts/:code/revisions/:revision/pdf` returns the generated PDF (`Content-Disposition:
attachment`) and records an event.
- `POST drafts/:code/signed` uploads the signed PDF: multipart `file`, `revision`, `signedOn`,
  `requestId`.
- `GET drafts/:code/signed/:revision` downloads the signed original and records an event.

Every write is idempotent per `requestId`. A stale `expectedVersion` (the draft's row version) gets `409 CONCURRENT_CHANGE`.

## 6. Template `cs-b2b-1` (working text)

- Header: "NÁVRH – K PRÁVNÍ KONTROLE", the draft code, revision, template version and generation
  date.
- Parties:
  - the supplier is a marked placeholder "[identifikace dodavatele – doplní právní kontrola]".
    The module never reads Finance's issuer, so nothing is guessed;
  - the customer is from the wizard.
- Subject: the service for the hotel and its address. Rooms, price per room and month without VAT
  and the currency, the start, billing and payment terms — exactly the entered values.
- Holders: the variant's working paragraph, marked "[pracovní text k právní kontrole]". It states
  no moment of transfer, no loan, no equipment price and no liability.
- Footer on every page: the draft marking and the page number.

## 7. The signed original (delivery 3) — concurrency and storage

Proposed with the review of #121 (CD121-3); a separate draft PR.

- **Upload:** `POST drafts/:code/signed`, multipart with `requestId`, `expectedVersion`,
  `revision`, `signedOn`, `confirm=true` and one `file`.
  - Only a **real, complete PDF with at least one page** (review SIGN122-R1), recognised by content,
    never by name or type:
    - the `%PDF-` header and `%%EOF` at the end (a truncated upload is refused);
    - the runtime's existing `pdf-lib` (as for label artwork) parses a copy that is never saved, and
      the PDF must have a page.
    - The stored bytes and any signatures in them stay exactly as uploaded.
    - No new dependency.
  - At most `SUPPLIER_DOCUMENT_MAX_BYTES` (the existing, verified limit of supplier documents);
    one file, held in memory.
  - Only for the **current** revision of a draft that is not removed, and only once per revision.
  - Signatures are not checked. The page says "evidence of a hand-uploaded signed PDF".
- **Concurrency with editing, removal and hotel links:** every write on a draft takes the same
  row lock (`SELECT … FOR UPDATE` on `contract_drafts`) first, then checks `expectedVersion`.
  - Uploading also checks that `revision` is still the current one, and bumps the version.
  - Of an upload and an edit, removal or link sent from the same version, exactly one commits.
    The other gets `409 CONCURRENT_CHANGE` and stores nothing (tested with an upload and a
    removal at the same moment).
  - A paper signed for revision r is never filed under r+1.
- **Storage:** the private `FileStorage` (local on DEV, S3 where configured), namespace
  `contract-documents/yyyy/mm/<uuid>.pdf`, a server-generated key with no user input.
  - The file is written inside the request's transaction, after its idempotency row (a replay
    never stores a second file) and before the record.
  - A failure in between leaves an unreferenced file, which is logged. There is never a record
    without its file.
  - The storage has no delete. Objects are never replaced.
  - SHA-256 and size are recorded. A download recomputes the hash and refuses a changed file
    (`STORED_FILE_CHANGED`).
- **Download:** `GET drafts/:code/signed/:revision` with the same access check (404 out of scope),
  `Cache-Control: private, no-store`, `Content-Disposition: attachment`, CSP sandbox, `nosniff`.
  Recorded as `SIGNED_DOWNLOADED`.
- **Lock, held by the database:**
  - `contract_signed_documents` is append-only, unique per draft and revision, and accepted only
    for the current revision of a draft that is not removed.
  - A draft with a signed original is never removed and its hotel link never changes.
  - A change after signing is a new revision (an amendment proposal); its own signed original can
    be uploaded later.
- **A draft signed without a hotel (review SIGN122-R2):**
  - The first link to an existing hotel stays possible: `sales:manage` + `hotels:read`, with a
    reason, audited (`from: null`, `to`, `signedRevisions`), under the same row lock.
  - Only to the hotel every signed revision names (name and address). An acknowledgement never
    overrides it (`HOTEL_NOT_SIGNED_HOTEL`), and a later amendment naming another hotel does not
    count.
  - After that, and for a draft signed with a hotel, the link never changes (API and DB).

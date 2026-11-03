# ADR 0043: Contract drafts — a manual generator in the core, kept apart from billing

- **Status:** Accepted — the owner approved the model on 2026-11-03 (merged with #120);
  implementation in delivery 2 (#121) and 3 (#122), each under independent review. Requested and
  scoped by the owner on 2026-11-03 (manual
  generator of a contract proposal; saving at a prospect or a hotel, editing, removing an unsigned
  proposal, uploading the already signed PDF). Details in doc 045.
- **Date:** 2026-11-03
- **Context:** Obchod (doc 034, ADR 0031) keeps hotel acquisition and creates nothing outside
  itself. Hotels live in the core module `customers` (doc 028). Finance keeps the billing terms
  of a hotel (doc 040). The owner calls those terms "Fakturační podmínky", not a contract (PR
  #119). A real, legally approved contract template does not exist yet. The owner wants a working
  prototype with a versioned Czech working text: proposal → saved draft → printable PDF → opened
  from the hotel → edited or removed while unsigned → the signed original uploaded and kept.

## Decision

1. **A new core module `contracts`, no new runtime and no new external supplier.**
   - It runs in the existing `api` process, writes only its own tables in the core schema, and
     stores files through the existing private `FileStorage` (new namespace `contract-documents`).
   - It reads prospects only through a service exported by `sales` and hotels only through
     `HotelsService` (`customers`), never through their tables. The FKs of its own tables to
     `sales_prospects` and `hotels` keep references valid; they write nothing there.
   - It never calls Finance, never reads or writes billing terms, and sends, signs or schedules
     nothing.
2. **Nothing happens by itself.** A draft exists only after an explicit "Uložit návrh".
   - Creating or changing a hotel, marking a prospect won and any change in Finance generate
     nothing.
   - The generator never creates a hotel. It links a hotel only when the user chooses one and
     saves.
3. **Access is evaluated on every operation, from existing permissions (no new permission):**
   - A draft linked to a prospect: the prospect's owner with `sales:work`, or `sales:manage`. This
     is the same scope as the prospect itself (doc 034 §7). Another salesperson's draft answers
     404, like their prospect.
   - Linking a hotel, a draft linked only to a hotel, and the block on a hotel's card:
     `sales:manage` and `hotels:read` (today ADMIN). A salesperson without `hotels:read` never sees
     hotels through this module.
   - Every read, PDF download, edit, removal, restore, hotel link, upload and download of the
     signed original checks this again. No list, count or error reveals a draft out of scope.
4. **Data (core migrations, own tables; details in doc 045 §3):**
   - `contract_drafts` holds the current state with a `revision`. It always points to a prospect
     or a hotel (DB CHECK). It also holds the template version and the removal fields
     (`deleted_at`/`by`/`reason`, restorable).
   - `contract_draft_revisions` is append-only and holds the full content of each saved revision.
     The PDF is always rendered from a revision and its template version, never from current
     inputs.
   - `contract_draft_events` is append-only: created, revised, removed, restored, hotel linked,
     PDF downloaded, signed original uploaded, signed original downloaded.
   - `contract_signed_documents` is append-only, one per draft revision: the stored file, its
     SHA-256 and size, the signed date entered by the user, the uploader and the time.
   - Database invariants:
     - A signed revision can never be changed or removed.
     - A draft with any signed original can never be removed.
     - A signed original can never be replaced.
     - The holder ownership is set exactly when the holders are chosen (`WITH`).
     - Amounts are exact decimals with at most two decimals, refused rather than rounded.
5. **The template is code, versioned, and is a working text.**
   - One Czech B2B template (`cs-b2b-1`, more versions later) lives in the repository. Each saved
     revision records the version it was made with.
   - Every page says **"NÁVRH – K PRÁVNÍ KONTROLE"**. The variant texts (holders and their
     ownership) are marked as working texts for legal review.
   - The application never presents the text as an approved legal model. It invents no binding
     term: no moment of transfer, loan, equipment price or liability.
6. **The signed original is a kept file, not a verification.**
   - Upload of a PDF only, recognised by content (`%PDF-`), within the size limit of the existing
     supplier documents (`SUPPLIER_DOCUMENT_MAX_BYTES`, one file).
   - Stored under a server key and never served publicly. Download only through the API with the
     same access check, recorded as an event.
   - The state says "signed original recorded (uploaded by hand)". Signatures are not checked
     automatically.
   - A change after signing is a new revision (an amendment proposal); the signed revision stays
     as it was.

## Consequences

- No Finance boundary changes and no new container, secret, DNS or supplier. Deployment is the
  ordinary core release: migrations plus `api` and `web`.
- When billing terms in Finance should once follow a signed contract, that handover is a separate,
  explicit step (a later stage) that needs its own decision.
- The working text must be replaced by a legally reviewed template before any real use. Until
  then, every PDF carries the draft marking.

## Delivery

1. This ADR and doc 045: boundaries for review.
2. Drafts: migration, API, the wizard in a prospect and on a hotel's card, PDF, editing and
   removal with restore, hotel link, tests.
3. The signed original: upload, protected download, the revision lock, tests.

Each step is a separate draft PR. Merge and deployment only with the owner's approval after
independent review.

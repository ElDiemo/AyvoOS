# 033 — Supplier details and goods barcodes at receiving

Owner request 2026-10-21 ("Dodavatelé a načítání čárových kódů při příjmu zboží"). Implements a
first, narrower part of issue #27; what is left of #27 is listed in §6. Builds on doc 018
(inventory and receiving) and doc 021 (access).

## 1. Supplier details

- The existing name, IČO (`companyId`) and DIČ (`vatId`) stay. New **optional** details:
  address (street, address line 2, postal code, city, country — ISO 3166-1 alpha-2), contact
  person, phone, e-mail and an internal note.
- Nothing is required except the name, also not of existing suppliers. The company id is the
  Czech IČO **or** a foreign registration number; it is never checked as an IČO, so a foreign
  supplier needs none, and DIČ is never required.
- Validation (API and DB CHECK): country `^[A-Z]{2}$`, phone `^\+?[0-9 ()/-]{6,30}$`, e-mail
  with `@`, trimmed texts with maximum lengths. No format of IČO/DIČ is imposed.

## 2. Corrections and history

The old rule "suppliers are immutable (only a one-way archive)" is replaced as follows, without
losing any history (ADR 0006):

- `supplier_revisions` (append-only): every version of the details. Revision 1 is the state at
  creation; for suppliers that existed before this change the migration copies their values as
  revision 1 **without author or reason** (nothing guessed). Later revisions carry the author,
  the reason (3–500 characters) and the request id.
- `suppliers` stays the current-state row with `revision`. The DB guard allows only (a) the
  one-way archive, as before, or (b) the change to the **next** revision whose recorded values are
  exactly the new row (same transaction). A new supplier must have revision 1 at commit (deferred
  constraint trigger). An archived supplier never changes again.
- `POST /api/admin/suppliers/:id/revisions` (`procurement:suppliers_edit`): the complete new
  details, the `revision` it was based on and a reason. A stale base revision → 409
  `SUPPLIER_CHANGED` (never overwritten blindly); no change → 422 `SUPPLIER_UNCHANGED`; a name
  taken by another supplier (case-insensitive) → 409 `SUPPLIER_EXISTS`. Idempotent per request
  id; audited as `SUPPLIER_UPDATED` with the reason and the names of the changed fields (the
  values are in the revision).
- Receipts, documents and lots reference the supplier and are **never rewritten**. A receipt
  shows today's name and, when it differs, the name it was recorded under
  (`supplierNameAtReceipt`, from the revision in effect when the receipt was created).

## 3. Goods barcodes of stock items

- `inventory_item_barcodes`: several codes per stock item. The value is stored **exactly** as
  scanned (text; leading zeros and letters kept, case-sensitive), printable ASCII without spaces,
  1–64 characters — not limited to EAN.
- **One active assignment per code** (partial unique index): a code active on another item is
  refused with that item named (409 `BARCODE_TAKEN`) — never taken over; concurrent assignments
  are serialised (advisory lock) with the index as the last line of defence.
- Retirement with a reason (one-way, row kept, author and time recorded); a retired code may then
  be assigned to another item. No delete (DB triggers). An archived item gets no new code.
- A code identifies **the item only**: never the supplier, quantity, pack size or lot. No GS1
  application identifiers, no pack conversions, no kg → ml, no lot guessing.
- Kept apart from the public QR identities of bottles and crates (separate table); a link such as
  an AYVO QR URL is refused as a goods code (`BARCODE_LOOKS_LIKE_QR`).
- Reading or looking a code up never writes stock movements (tested).

Routes: `GET inventory/barcodes/lookup?code=` and `GET inventory/items/:code/barcodes`
(`inventory:read`); `POST inventory/items/:code/barcodes` and `POST inventory/barcodes/:id/retire`
(`inventory:barcodes_manage`).

UI: Sklad → Stav skladu → each item → "Čárové kódy" (list, assign, retire, retired history).

## 4. Access (doc 021)

| Permission                         | Who                                     | What                                                                                                               |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `inventory:read`                   | existing roles                          | supplier list and detail: name, IČO, DIČ, address — **no contact, note or history**; barcode lookup and item codes |
| `procurement:suppliers_manage`     | ADMIN, WAREHOUSE_SUPERVISOR (unchanged) | create, archive; sees contacts, note and history                                                                   |
| `procurement:suppliers_edit` (new) | **ADMIN only**                          | corrections with a reason                                                                                          |
| `inventory:barcodes_manage` (new)  | **ADMIN only**                          | assign and retire codes                                                                                            |

Contacts of the supplier's staff are personal data and are not part of reading stock: they are
omitted (not null) without `suppliers_manage`/`suppliers_edit`. Prices and documents keep their
own permissions (`procurement:cost_read`, `procurement:documents_read`); the supplier detail
contains neither. Both new permissions are warehouse-scoped like the existing ones. Whether
receiving staff should see supplier contacts is an **open question for the owner** (§6).

## 5. Receiving with a scanner

The receipt form has "Načíst kód zboží" above the lines. A keyboard-wedge scanner types the code
and Enter:

- Enter in the field only looks the code up; it never submits or confirms the receipt.
- A known code selects its item and shows its name, code and unit. Already on a line → nothing
  is added and the quantity is not touched; otherwise the first untouched preset line is used,
  else a new line. The focus moves to that line's quantity.
- Quantity, supplier, lot and document stay explicit operator input; the scan receives nothing.
- Unknown code: nothing is created. With `inventory:barcodes_manage` the code can be assigned to
  an item right there (explicit action); otherwise the user chooses the item manually and is told
  that an administrator assigns codes. Retired codes, links (QR) and Czech-keyboard-layout input
  ("ěščř…" instead of digits — explained, never converted) are reported.
- On a network error the form stays unchanged, the code returns to the field and the focus too.
- Scans are processed in the order read. Manual item selection works as before.

## 6. Not in this change (issue #27 and later)

- Several contacts per supplier with roles, a second address (warehouse / pick-up), web, short
  display name, a list of receipts/documents on the supplier card.
- Supplier SKUs, pack sizes and conversions, GS1 parsing, price lists, purchase orders.
- **Open question:** may receiving staff (`inventory:read` / `inventory:receive` without
  supplier management) see supplier contacts? Now: no.

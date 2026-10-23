# 034 — Obchod: evidence akvizice hotelů (v1)

Status: implemented for review (owner request 2026-10-21). Not deployed.
Related: doc 019 (company functions), doc 021 §4c (planned roles), doc 028 (operational hotels),
ADR 0031 (Obchod as a separate function, SALES scoped by ownership).

## 1. Scope

A small, usable sales CRM for **hotel acquisition**. A salesperson always sees whom they are
working on, what happened, what to do next and when.

- New company function **Obchod** with three pages: **Přehled**, **Akvizice**, **Úkoly**. It is a
  separate navigation module, apart from Hotely, Výroba, Sklad and Expedice.
- A **prospect** (`zájemce`) is not an operational hotel. Creating one needs no site, warehouse,
  recipe or carrier settings, and it never creates or changes anything outside Obchod — not even in
  stage **Získaný**.

Not in v1 (explicitly out of scope): hand-over to operations (no operational hotels, orders,
contracts or shipments are created), presentations and savings calculators, sending e-mails,
calling or mail synchronisation, the hotel portal, commissions and invoicing.

## 2. Data model (module `sales`, PostgreSQL)

| Table              | Kind                         | Content                                                                                                                                                      |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sales_prospects`  | current state (+ `revision`) | code `AKV-000001`, name, country, city, optional address, estimated rooms, accommodation type, website, source, owner, priority, stage, lost reason, note    |
| `sales_contacts`   | current state (+ `revision`) | label (a name **or** a designation such as "Recepce"), position, e-mail, phone (text), note, main contact flag; retired, never deleted                       |
| `sales_activities` | **append-only**              | kind, occurred at (real time of the event), recorded at, author, optional contact, content, outcome; a correction is a new row pointing to the corrected one |
| `sales_tasks`      | current state (+ `revision`) | what to do, prospect, optional contact, assignee, due date, status (open / done / cancelled), note, result                                                   |
| `sales_events`     | **append-only**              | every change of the prospect, its contacts and tasks: who, when, before → after                                                                              |

Rules held by the database:

- No row of these tables is ever deleted. Activities and events cannot be updated either; a
  correction is a new activity, a change of current state is written together with its event in
  one transaction.
- `lost_reason` is required exactly when the stage is **Neúspěšný**.
- Priority is A, B or C, or unknown. Estimated rooms are 1–100000 or **unknown** (NULL, never 0).
- At most one active main contact per prospect (partial unique index).
- An activity cannot happen later than it is recorded (5 minutes of clock tolerance), and each
  activity is corrected at most once. A correction belongs to the same prospect.
- A task is open, done or cancelled; a closed task records who closed it and when. A cancellation
  carries its reason.

Not unique on purpose: hotel name, e-mail, phone and website. A chain or one contact person may
legitimately appear at several hotels (§8).

## 3. Prospect

Quick creation needs only the **name** and the **country**. City, address, rooms, type, website,
source, priority, note and contacts are optional and can be added later. The owner is the creator
(ADMIN may choose another salesperson).

- Country is an ISO code chosen explicitly; addresses and phone numbers are free text, foreign
  formats are fine.
- Accommodation type (proposal, editable later): hotel, penzion, apartmány, hostel, jiné — or
  unknown.
- Source is free text (e.g. "doporučení", "veletrh"); no fixed list is invented.

## 3a. Archiving (owner 2026-10-22, follow-up PR)

A prospect created by mistake, a closed hotel or a duplicate record can be **archived** and later
**restored**. Archiving is **not a stage**: the stage stays (an archived prospect is never shown as
Neúspěšný), and nothing is deleted — contacts, activities, tasks and history all remain.

- Archiving needs a reason (3–500 characters); restoring takes an optional one. Both are events
  (`PROSPECT_ARCHIVED`, `PROSPECT_RESTORED`) with who and when.
- A prospect **with open tasks is not archived**: the request is refused with the list of the open
  tasks, and the dialog leads to them. Nothing is completed or cancelled automatically.
- While archived the prospect is read-only: no profile, stage or owner change, no contact,
  activity, correction or task. Held by the database too (triggers on prospects, contacts,
  activities and tasks); the application refuses it first with `409 PROSPECT_ARCHIVED`.
- Archived prospects are not in the default list, the search results or the overview; the list
  shows them with the filter **Archiv → Archivovaní**. A duplicate check still finds them (marked
  "archivovaný"), so a hotel is restored rather than created again.
- The owner archives and restores their own prospects; `sales:manage` (ADMIN) any. Another
  salesperson's prospect is a 404, as everywhere.
- Restoring brings the prospect back as it was: the same stage and contacts, no new task.

## 4. Stages

Nový → Oslovený → Jednání → Nabídka → Získaný / Neúspěšný.

- Any stage may be set from any stage. Moving **back**, or leaving Získaný / Neúspěšný (reopening),
  requires a reason. Neúspěšný requires its reason (why the hotel said no).
- Every change is a `STAGE_CHANGED` event with before, after, the reason and who did it.
- A stage change is not an activity: it never claims that an e-mail was sent or a call was made.
  Calls, e-mails, meetings, samples and offers are activities.

## 5. Activities and history

Kinds: telefonát, odeslaný e-mail, přijatý e-mail, schůzka, vzorky, nabídka předána, poznámka.
E-mails are recorded by hand; the application sends nothing.

- An activity has the real time of the event (entered by the salesperson, e.g. yesterday's call),
  the time it was recorded, its author, the contact, the content and the outcome.
- **Correction**: a new version with a reason. The original stays visible as "opraveno".
  **Withdrawal** ("zapsáno omylem") is a correction without content, again with a reason.
- **First contact** and **last contact** are derived from the current versions of activities
  of the kinds call, e-mail sent or received, meeting, samples and offer. Notes, tasks and
  profile edits never count as contacting the hotel.
- The detail shows one time line: activities, plus stage and owner changes. Other changes
  (profile, contacts, tasks) are listed under "Všechny změny".

## 6. Tasks (follow-up)

A task is what someone will do; an activity is what happened. Several open tasks per prospect are
fine.

- The list of prospects shows the **nearest open task**, derived from the tasks. There is no
  separate "follow-up" field.
- After recording an activity the form offers an optional next task (one step, never required).
- Rescheduling, completion (with an optional result) and cancellation (with a reason) are
  events. A closed task is not reopened; a new task is created instead.
- Completing a task never changes the stage.
- **Editing** an open task (owner 2026-10-22): title, note and contact in the detail ("Upravit");
  the due date moves through "Přesunout". The assignee is chosen only with `sales:manage`, and
  only among the prospect's owner and sales administrators — a salesperson never gives work to
  another salesperson. A salesperson may edit a task ADMIN gave to someone else: the unchanged
  assignee is kept, never changed (not even back to themselves). Each edit carries its revision; on a conflict the dialog keeps what was
  typed, reloads the current state in place and lets the user save again. Closed tasks are not
  edited or reopened (§11.4).
- **Time zone**: due dates are calendar days, and "today" or "overdue" are evaluated on the server
  in **Europe/Prague** (`SALES_TIME_ZONE`). Activity times are entered and shown in the same zone,
  never in the device's zone. Salespeople in another time zone are an open question (§11).

## 7. Permissions and ownership

| Permission     | Meaning                                                                                        | ADMIN | SALES |
| -------------- | ---------------------------------------------------------------------------------------------- | :---: | :---: |
| `sales:work`   | Obchod: own prospects — create (owned by the creator), read, edit, contacts, activities, tasks |   ✓   |   ✓   |
| `sales:manage` | all prospects and tasks; assign or reassign owners; assign tasks to other people               |   ✓   |   –   |

- Visibility is evaluated on the server for every read and write, including contacts, history,
  counts, search and duplicate warnings. Without `sales:manage` the user only works with
  prospects they own. Another person's prospect answers **404**, whether opened by URL or API.
- A salesperson cannot change the owner. ADMIN's reassignment moves the previous owner's open
  tasks of that prospect to the new owner, recorded as events.
- Neither permission is bound to a site. Obchod needs no active site, warehouse or production.
- **SALES is assignable now** for Obchod only. Its previous planning template
  `inventory:stock_summary` is removed, so SALES has no warehouse access; that permission stays
  available for custom roles. FINANCE and HOTEL_USER stay planned (doc 021 §4c). No sales-lead
  role is added.
- A SALES-only account signs in to the overview, which shows the Obchod panel. It never lands on
  a warehouse page and is never asked for a site.

## 8. Duplicates and concurrent edits

- **Possible duplicate**: the same normalised name in the same country, the same website domain,
  or a contact with the same e-mail or phone (digits only). Creating a prospect with a possible
  duplicate needs an explicit "Přesto založit". Nothing is ever merged.
- The check runs **only among the prospects the user may access**: a salesperson's own prospects,
  everything for `sales:manage` (ADMIN). Another salesperson's prospect is never matched — not as
  a name, a count, a warning or a different API response — so the check cannot be used to probe
  whether a name, website, e-mail or phone is known elsewhere. Two salespeople may therefore keep
  the same hotel; ADMIN sees such pairs in the detail ("Možná duplicita") and resolves them by
  reassignment.
- **Creating at the same time**: every write that creates prospects for one owner — a manual
  create or an import confirmation — runs one at a time for that owner (a transaction-scoped
  advisory lock keyed by the owner). The second one checks possible duplicates against what the
  first one committed, so neither slips past the other unseen; a possible duplicate is still only a
  warning ("Přesto založit", or confirming the row in the import). The lock is keyed by the owner
  written for: a salesperson only ever waits for writes into their own prospects, never for
  anything about another salesperson's. Nothing becomes unique (names, phones, e-mails stay free).
- **Concurrent edits**: every update of a prospect, contact or task carries the revision it was
  based on. A newer revision is refused with `409 …_CHANGED`, so the last save never silently
  overwrites somebody else's change. The form keeps the user's input and offers a reload.
- Every write is idempotent per request id, so a double click never creates a duplicate.

## 9. Screens

- **Přehled** (`/sales`): my tasks today, overdue and upcoming (7 days), and my prospects in
  progress (Oslovený, Jednání, Nabídka). ADMIN can switch to everyone.
- **Akvizice** (`/sales/prospects`):
  - search by name, city and contacts (label, e-mail, phone). Phone numbers are compared only for
    a query written like a phone (digits with spaces, "+", brackets, "/", "-" or ".", at least four
    digits, compared by the last nine): "Penzion 2024" is a name and never finds a hotel whose
    phone contains 2024. The export uses the same filter;
  - filters by owner (ADMIN), stage, priority, country and the next task (overdue, today, next 7
    days, none);
  - a page of 25 with the total count and a stable order: next task, then name, then code;
  - shown per row: last contact and the concrete next step;
  - desktop shows a table, a phone shows cards. Long notes are not shown in the list.
- **Detail** (`/sales/prospects/AKV-…`):
  - at the top: identification, stage, priority, owner and the next task;
  - quick actions **Zapsat aktivitu** and **Přidat úkol**;
  - contacts, open and closed tasks, and the history.
- **Úkoly** (`/sales/tasks`): my open tasks by due date (overdue, today, upcoming), finished
  tasks on request. ADMIN can choose everyone or one person.

Forms keep their input on any error. A repeated click reuses the request id.

## 10. API (`/api/admin/sales`, all `sales:work` unless noted)

- `GET overview`
- `GET prospects`, `POST prospects`, `GET prospects/duplicates`, `GET prospects/:code`
- `POST prospects/:code/update | stage`
- `POST prospects/:code/owner` (`sales:manage`)
- `POST prospects/:code/archive | restore`
- `GET prospects?archived=archived` (archived only; default: the active ones)
- `POST prospects/:code/contacts`, `POST prospects/:code/contacts/:id/update | retire`
- `POST prospects/:code/activities`, `POST prospects/:code/activities/:id/correct`
- `POST prospects/:code/tasks`, `GET tasks`, `POST tasks/:id/update | reschedule | done | cancel`
- `GET salespeople` (`sales:manage`)

## 11. Open questions for the owner

1. Time zone of salespeople outside the Czech Republic (now Europe/Prague for everyone).
2. Accommodation types and their names (proposal in §3).
3. May a salesperson see a colleague's prospects (read-only), e.g. for a chain? Now: no.
4. Should a closed task be reopenable? Now: no; a new task is created.
5. ~~Should a prospect created by mistake be archivable?~~ Decided 2026-10-22: archive and
   restore (§3a), never deletion.

## 12. Follow-up work (owner 2026-10-21)

- Editing an existing task in the UI — done in the follow-up PR (§6).
- Archiving a prospect — done in the follow-up PR (§3a).

## 13. CSV import and export (owner 2026-10-22, follow-up PR)

The lists salespeople keep in spreadsheets today come into Obchod as CSV. XLSX, Google Sheets and
any synchronisation are not part of this version.

### Import

**Nahrát → přiřadit sloupce → náhled → výslovně potvrdit → výsledek** (Akvizice → „Import CSV“).

- **File**: comma or semicolon (detected from the header line), quotes, doubled quotes, empty
  cells, notes over several lines, UTF-8 (with or without BOM) or the Windows-1250 that Czech Excel
  writes. Every value is text: a phone keeps its "+" and leading zeros. The file stays in the
  browser and is sent for each step; **it is never stored**. Text after a closing quote
  (`"Hotel A" dovětek`) is never cut off: the row gets the error „Za ukončovací uvozovkou…“
  (`QUOTE_INVALID`) and cannot be imported; spaces there are ignored; such a header refuses the
  file (`CSV_QUOTE_INVALID`).
- **Limits**: 2 MB, 2000 data rows, 60 columns (`SALES_IMPORT_*` in `packages/types`). Larger
  files are refused with the reason (413 / `IMPORT_TOO_MANY_ROWS`); split them.
- **Columns**: name, country, city, address, postal code, estimated rooms, accommodation type,
  website, source, priority, note, and one contact (name or a designation such as "Recepce",
  position, e-mail, phone). A proposal comes from the header names; the user decides. Unknown
  columns are not used unless chosen.
- **Old columns** such as "Stav", "Datum prvního oslovení", "Výsledek" or "Follow-up odeslán" are
  never turned into calls, e-mails, completed tasks or a stage. They can be kept as labelled
  original values in the note ("Původní údaje z importu (význam nepotvrzen): …"). Every imported
  prospect starts in **Nový** without activities or tasks; no event time is invented.
- **Required**: name and country. A missing value is completed in the preview (per row), or the
  country for empty cells is set explicitly for the import. **The country is never derived** from
  a domain, a phone number or the user's site. A contact without a name needs an explicitly chosen
  designation (e.g. "Recepce"); no person is invented.
- **Preview writes nothing.** It lists each row with its number (the spreadsheet row, header =
  1), concrete errors (missing name or country, unknown country or type, rooms that are not 1–100000,
  priority other than A/B/C, invalid e-mail or phone — e.g. "4,20777E+11" from Excel — too long
  text, extra cells, text after a closing quote), duplicates within the file, and possible duplicates among the prospects the
  user may see (the rules of §8, archived ones included). Nothing is merged or overwritten.
- **Choice**: rows with errors cannot be selected. A possible duplicate is imported only when the
  user confirms it as a new record ("Je to jiný hotel — založit jako nový").
- **Owner**: a salesperson imports only for themselves. ADMIN (`sales:manage`) may choose an
  active salesperson with Obchod.
- **Only what the preview showed**: the preview returns a fingerprint of the file's bytes and of
  every decision (mapping, defaults, typed fixes, owner, the user). The confirmation carries it; a
  file saved again since, or other decisions, are refused (`IMPORT_PREVIEW_STALE`) and the wizard
  loads the preview again — typed fixes kept, rows chosen anew, nothing confirmed automatically.
  Typed fixes must be checked ("Použít opravy a znovu zkontrolovat") before the import can be
  confirmed.
- **Confirmation**: permissions, the target owner, every selected row and the duplicates are
  checked again on the server; anything that changed since the preview is refused with the rows
  concerned (`IMPORT_ROWS_INVALID`, `IMPORT_DUPLICATES_UNCONFIRMED`, `NOT_A_SALESPERSON`) and the
  wizard refreshes its preview. All selected rows are written in one transaction (all or nothing),
  idempotent per request id: a double click or a retry after a lost answer imports once; the same
  request id with another selection is a conflict. Confirmations and manual creates for one owner
  run one at a time (§8): a parallel one with another request id (a second tab, a reload after a
  lost answer, the same hotel typed by hand) finds the rows as possible duplicates and writes
  nothing.
- **Result** (`IMP-000001`, page `/sales/prospects/import/IMP-…`): created prospects with their
  row numbers, the rows left out with the reasons. Stored append-only in `sales_imports` (row
  numbers and error codes only, never contact data); every created prospect keeps its import and
  row (`import_id`, `import_row`, immutable) and its `PROSPECT_CREATED` event names the import.
  Only the importer and `sales:manage` see an import; nobody else can read its file, preview or
  result.

### Export

Akvizice → „Export CSV“ downloads the **current filtered list, all pages** (at most 10000 rows,
`EXPORT_TOO_LARGE` above), in the list's scope: a salesperson exports only their own prospects
(an owner filter cannot widen it), ADMIN as chosen. Columns in Czech (so the import recognises
them again): code, profile, stage, lost reason, owner, last contact, next step and its date, the
main contact (or the first active one), the number of contacts, the note and whether archived.

The file is UTF-8 with BOM, `;` and CRLF (opens in Czech Excel). **CSV injection**: a value
starting with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe
so that a spreadsheet shows it as text and never runs it. Only the exported text changes — the
database keeps the original value, and the import removes that apostrophe again.

### API

- `GET prospects/export` (the list's query parameters)
- `POST imports/inspect`, `POST imports/preview`, `POST imports` (multipart: `file` + JSON field
  `options`), `GET imports`, `GET imports/:code`

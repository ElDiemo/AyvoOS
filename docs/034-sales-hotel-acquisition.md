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
- A salesperson sees only the duplicates they can access, with a link. Inaccessible ones are
  reported only as a count ("u jiného obchodníka — řeší administrátor"), never with names or
  contacts.
- Known limit: the count of hidden duplicates tells a salesperson that a matching name, website,
  e-mail or phone exists at another salesperson's prospect, without saying whose or which. A
  salesperson could use the warning to probe whether a given e-mail is known. Accepted for v1,
  since the warning is the point of the check. Restricting it to name and website is an option
  for the owner.
- **Concurrent edits**: every update of a prospect, contact or task carries the revision it was
  based on. A newer revision is refused with `409 …_CHANGED`, so the last save never silently
  overwrites somebody else's change. The form keeps the user's input and offers a reload.
- Every write is idempotent per request id, so a double click never creates a duplicate.

## 9. Screens

- **Přehled** (`/sales`): my tasks today, overdue and upcoming (7 days), and my prospects in
  progress (Oslovený, Jednání, Nabídka). ADMIN can switch to everyone.
- **Akvizice** (`/sales/prospects`):
  - search by name, city and contacts (label, e-mail, phone);
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
- `POST prospects/:code/contacts`, `POST prospects/:code/contacts/:id/update | retire`
- `POST prospects/:code/activities`, `POST prospects/:code/activities/:id/correct`
- `POST prospects/:code/tasks`, `GET tasks`, `POST tasks/:id/update | reschedule | done | cancel`
- `GET salespeople` (`sales:manage`)

## 11. Open questions for the owner

1. Time zone of salespeople outside the Czech Republic (now Europe/Prague for everyone).
2. Accommodation types and their names (proposal in §3).
3. May a salesperson see a colleague's prospects (read-only), e.g. for a chain? Now: no.
4. Should a closed task be reopenable? Now: no; a new task is created.
5. Should a prospect created by mistake be archivable? Now: no deletion and no archive.

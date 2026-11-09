# 060 — Obchod: decisions for the owner (proposal)

Status: **proposal, nothing implemented.** It collects the Obchod follow-ups the owner kept separate
on 2026-11-09 (after #155 next step, #156 owner results, #157 visit guide). For each one it gives
what exists now, the options and a recommendation. New fields, stages and data need the owner's
model approval (CLAUDE.md "Domain models need owner approval"); nothing here is a decided rule.

Not in scope: D2 "revoked labels" belongs to the bottle cycle (doc 048, PR #128), not to Obchod.

## A. New prospect fields: current cosmetics, main objection, decision maker

**Now.** The visit guide (#157) writes them as text lines in the Schůzka ("Současná kosmetika: …",
"Námitky: …", "S kým: …"). They are in the history but cannot be filtered or counted.

**Options.**

1. Keep them as text in activities (no change).
2. Optional current-state fields on the prospect, each change an event (doc 034 §2 pattern):
   - `current_amenities` — free text (supplier / type, e.g. "jednorázové lahvičky");
   - `main_objection` — one value of a list **the owner supplies** (e.g. cena, vzhled, logistika,
     současný dodavatel, termín), or unknown;
   - the decision maker stays a contact (`sales_contacts` already has a position).
     The visit guide would offer to copy its answers into the fields (never silently).

**Recommendation.** Option 2 with the two fields only, after the owner gives the objection list.

**Questions.** Which objections? Is "current cosmetics" free text or a list too?

## B. New stages Pilot and Odloženo

**Now.** Nový → Oslovený → Jednání → Nabídka → Získaný / Neúspěšný (doc 034 §4). "In progress" for
the next step and results is Oslovený, Jednání, Nabídka.

**Options.**

1. **Pilot** as a stage between Nabídka and Získaný. It counts as in progress (needs a next step).
2. **Odloženo** ("ozvat se v březnu"):
   - (a) a stage with a required "until" date; it leaves the "bez dalšího kroku" list;
   - (b) no stage — an ordinary task with that due date keeps the prospect off the list already.

**Recommendation.** Pilot as a stage if pilots really happen; Odloženo as (b), because a task with a
date already says the same and the stage would be a second source of truth.

**Questions.** Does a pilot happen before or after the signed contract? Does it need its own
fields (start, end, number of rooms)?

## C. External reminders (e-mail)

**Now.** Tasks and overdue tasks are visible only inside the app (Přehled, Úkoly, the calendar in
#153). Nothing is sent.

**Options.**

1. A morning e-mail to each salesperson: today's and overdue tasks, links into the app, no
   customer data beyond the hotel name. Opt-in per user. Mail through the existing approved mail
   transport (`AUTH_MAIL_DRIVER`). It needs a **scheduler**, which DEV and PROD do not run today.
2. A calendar feed (iCal URL with a secret token). It exposes task titles outside the app and a
   leaked token cannot be noticed. **Not recommended.**

**Recommendation.** Option 1, first without a scheduler (an admin "send today's reminders" button)
to check content and delivery; the schedule only after the owner approves it for DEV and PROD.

**Questions.** E-mail at all? What time? Also on weekends?

## D. Price list and calculator in Obchod

**Now.** Prices exist only in Finance (doc 040: the default price list and the agreement's own price
per room and month). Finance is its own runtime (ADR 0039); the core never reads Finance tables and
there is no core → Finance call.

**Options.**

1. An indicative calculator in Obchod: rooms × an **indicative** price the owner enters in Obchod,
   clearly labelled "orientační, ne nabídka". It never touches Finance or billing.
2. Read the Finance default price list through a new explicit contract. That is an architecture
   change (a new core → Finance dependency) and needs an ADR.

**Recommendation.** Option 1, if the owner wants the salesperson to quote at all.

**Questions.** May a salesperson show a price at the visit? One indicative price per currency, or by
hotel size?

## E. Results (#156): two counting choices to confirm

- **Won** is credited to the prospect's **current** owner; calls, meetings and offers to their
  **author**. Alternative: the owner at the moment of the stage change.
- **Posuny** count a prospect that reached a stage in the period even if it moved on or back later.

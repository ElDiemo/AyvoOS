# 063 — First hotel on the portal: DEV rollout plan and customer walk (proposal)

Status: **plan for the owner, nothing deployed.** Owner's priority 2026-11-10: finish the hotel
portal for the first hotel, review and CI, then **DEV first**, then the owner walks it as a real
hotel customer on a phone and a desktop. Merges and the DEV deploy need the owner's explicit
approval; this plan only prepares them.

## 1. What goes in, in this order

| Step       | PR                 | What                                                                | State 2026-11-10 morning                                   |
| ---------- | ------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1          | #148               | Signed contracts, read only                                         | CI green; waits for review                                 |
| 2          | #149               | Deliveries, nearest delivery, 60-day plan days                      | stacked on #148; review findings P2×2 handed to its author |
| 3          | #170               | "Moje hotely" dispatch at a glance; isolation across several hotels | stacked on #149                                            |
| (later)    | #150               | Invoice package (ZIP)                                               | after the deliveries, owner 2026-11-10                     |
| (optional) | #161 → #163 → #165 | Zabezpečení účtu (new phone, sign out everywhere, change password)  | #161 CI green                                              |

Each stacked PR is retargeted to `main` after its base merges (a push then starts CI: retargeting
alone does not). Invoices, the hotel profile and contacts are unchanged by all of them.

## 2. DEV deploy (after approval) — doc 052

1. `scripts/deploy-dev.sh --check` and `scripts/deploy-finance-dev.sh --check` on the merged commit.
2. Build and start portal-web as doc 052 §"Deploy the reviewed commit", then `scripts/deploy-dev.sh`
   (core migrations run there; #148/#149/#170 add **no** migration; #165 adds none either).
3. Verify per doc 052 §"Verify and disable"; rollback per §"Return portal-web to the previous image"
   (`deploy-dev.sh --rollback <running Core tag>`), never by hand in the database.

## 3. Synthetic data for the walk (DEV only, no real customer)

Through the staff UI, as an administrator:

- a test payer with two hotels (Finance → Plátci) and a portal account with a grant on **both**
  (Hotely → Uživatelé, #147, or the Finance payer page);
- for hotel 1: an active supply plan (whole crates, a few days in the next 60 days), one open
  order, one shipped to the simulated carrier, one delivered; for hotel 2: one open order only;
- a signed contract PDF on hotel 1 (Smlouvy).
  Never the live PPL account on DEV; the DEV carrier is the simulation.

## 4. The customer walk (phone ≈ 390 px and desktop)

1. Invitation e-mail → activation (password + authenticator) → recovery codes shown once.
2. **Moje hotely:** both hotels, each with "Nejbližší expedice (plánované odeslání)" and
   "Poslední zásilky"; a plan day says "Podle plánu"; nothing says an arrival date.
3. Hotel 1 → profile: "Nejbližší dodávka", contracts card, tabs Profil / Dodávky.
4. **Dodávky:** planned / in progress / delivered with products in crates and bottles, the planned
   ship day apart from "Předáno dopravci" and "Doručeno"; "Další podle plánu zásobování" for 60
   days, marked indicative.
5. Hotel 2 shows only its own order; hotel 1's never appears there.
6. Profil hotelu: edit a contact with a reason → saved; AYVO sees the change history (#151).
7. Faktury: list, payment state, PDF (TEST invoices on DEV, labelled).
8. Smlouvy: download the signed PDF.
9. Odhlásit; sign in again with a code; (optional #161–#165) a new phone, sign out everywhere.
10. Staff side: revoke the grant on hotel 2 → it disappears for the hotel user at the next page.

Record what looks wrong or unclear per step (screen, width, text) for the tuning round.

## 5. Open points for the owner (none blocks the walk)

- A planned order whose ship day passed shows "Odešleme co nejdřív" (#170). Keep the wording?
- Several shipments on the way: the home page lists up to 3 and "a n další na cestě".
- No arrival estimate anywhere (doc 056): keep it so?

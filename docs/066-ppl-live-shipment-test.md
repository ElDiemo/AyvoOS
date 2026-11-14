# 066 — One live PPL shipment: label → pickup → delivery → return (plan, nothing run)

Owner request 2026-11-14 (with the correction of the same day). This is a **plan for a later,
separately approved run** — nothing here has been done: no write on PROD, no address change, no
paid PPL request, no activation without confirmed data and a date. It uses only the existing
processes and the pickup order of doc 029 §11; it invents no shortcut, fake filling or database
write.

## 0. Fixed by the owner

- Site **CZ-PREROV-01** (Přerov) is the physical place of dispatch, pickup and return. Every test
  bottle, the crate and their QR identities belong to it and stay there for later use. No
  artificial site, no alternative dispatch.
- Hotel **HT-000001**, fulfilled by CZ-PREROV-01. Its delivery
  address becomes the owner's own confirmed address **only for the concrete run** (an ordinary
  hotel change by a person with `hotels:manage`, recorded; not now).
- The crate physically travels there and back; the same permanent crate QR and bottle QR stay.
- The return uses its own PPL return label or pickup, depending on what PPL's service allows
  (§5) — the outbound pickup is the implementation task of doc 029 §11.

## 1. Blocker: an empty-bottle crate is not a supported use case today

The owner's scenario is a crate of **empty** bottles with pumps, production steps simulated. The
existing process does not allow it without faking data, which is excluded:

| Step                                  | Rule today                                                                                               | Evidence                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Picking a crate for an order          | only a `FILLED` cycle (Hotovo)                                                                           | doc 028 §2; `orders.service.ts` `CRATE_NOT_FINISHED`  |
| Hotovo                                | every member filled (`memberCount = filledCount = capacity`)                                             | doc 025 §6; `filling.service.ts` `CRATE_NOT_COMPLETE` |
| Filling a bottle                      | records one liquid lot, the recipe's liquid (today 330 ml) and 1 pump as **consumed**                    | doc 025 §0.2                                          |
| Return identification (counter 0 → 1) | `SORTED` only for a bottle whose status is `FILLED` in a delivered cycle; otherwise `NOT_IN_CIRCULATION` | `return-receipts.service.ts`; ADR 0011                |

Recording "filled" for a bottle that is physically empty would be exactly the fake filling the
owner excluded (it also books liquid that was never used). **An empty-bottle test parcel is a
different use case** (a transport test of packaging, not a delivery of goods). The owner decides
between:

- **A — a real Hotovo crate** (below, §2–§6): the bottles are really filled with the real product
  and the consumption is real; everything else (dispatch, pickup, tracking, delivery, return,
  counter, "Po mytí") is exactly the ordinary process. No code change.
- **B — a new "test shipment of empty packaging" use case**: a model and flow decision of the owner
  (doc, then implementation — e.g. a shipment not derived from order picking, never counted as a
  delivery or a reuse cycle). Not designed, not implemented. The pickup order of §11 would serve it
  unchanged.
- **C — PPL only**: verify label → pickup → tracking → delivery with an ordinary parcel that is not
  an AYVO crate (PPL's own tools, outside AYVO OS). Verifies the carrier, not AYVO's bottle cycle.

## 2. Variant A — test stock kept apart from real consumption

There is **no TEST flag** on lots, receipts or batches (only Finance bank transactions have one);
lots and receipts are immutable and corrected only by compensating entries. So the separation is
by naming and by an explicit, recorded receipt:

- **Test goods receipt** of the physical items used, with its real delivery note or invoice
  (doc 018 §3 — nothing is invented); supplier lot text `AYVO-PPL-TEST-2026-11` on each line, so
  the lots are found and reported apart. If the items are taken from existing stock instead, no
  receipt is written and the consumption below comes from those lots (the owner chooses; the lot is
  chosen explicitly at each step — never FIFO).
- **Real consumption** happens only at labelling and filling and is recorded as such (it is real:
  the bottles leave the warehouse full).

Exact quantities for one crate of **N** bottles (N = the capacity of the crate type of the product's
active recipe; the current products use `CRATE-40`, so **N = 40**):

| What                | Receipt (test lot)  | Written at labelling (`LABEL_APPLIED`) | Written at filling (`FILL`)  | At Hotovo, picking, labels, pickup, hand-over |
| ------------------- | ------------------- | -------------------------------------- | ---------------------------- | --------------------------------------------- |
| NEW_BOTTLE (body)   | N pcs               | −1 per bottle → −N                     | —                            | nothing                                       |
| Label media         | N × recipe qty (1)  | −recipe qty per bottle → −N            | —                            | nothing                                       |
| Liquid (recipe lot) | N × recipe (330 ml) | —                                      | −330 ml per bottle → −13.2 l | nothing                                       |
| PUMP                | N pcs               | —                                      | −1 per bottle → −N           | nothing                                       |

A smaller test crate (e.g. N = 2) is possible only through the catalogue — a new crate type (capacity
is data, ADR 0021; immutable once created), and a product or recipe version that uses it, because an
order line takes its capacity from the active recipe (doc 028 §1). That is a change of the real PROD
catalogue and needs the owner's explicit decision; it is not proposed here.

Also written (no stock): bottle registration `BC-…` (N bottles `CREATED`), the label print job,
crate registration and QR, product-label approval, the crate cycle (`OPEN_ASSEMBLY` →
`READY_TO_FILL` → `FILLING` → `FILLED`), the order, its shipment and parcel, the PPL labels, the
pickup, tracking events, the return receipt and the after-wash records.

## 3. Before the run (read-only and settings — each a separate approval)

1. **PPL account:** confirm with PPL (or in its portal) the **registered collection address** of the
   account = CZ-PREROV-01, whether a **regular pickup** exists (then the pickup order may not be
   needed for that day), and that the contract allows **CollectionOrder** with the chosen product.
   Ask the open questions of doc 029 §11 (window format, cut-off, sender = registered address).
2. **Site settings** (Správa systému → Provozovny → CZ-PREROV-01 → Dopravci a expedice): connection
   `PPL_PRODUCTION` (ADR 0042 confirmation), the sender address **identical** to the registered one,
   product, labels; then **"Ověřit připojení"** (token + product list — read-only, creates nothing).
3. **Hotel HT-000001:** the owner's confirmed delivery address, entered only for the run.
4. Deployed release containing doc 029 §11 (its own approval; no pickup order exists before it).

## 4. The run (variant A; every step in the ordinary UI)

1. Test receipt (§2) → registration, labels, labelling into the crate → filling → **Hotovo**.
2. An ordinary internal order of HT-000001 for one crate, ship day = the pickup day.
3. Picking (scan the crate) → **Vytvořit přepravní štítky** (one PPL shipment, one label — this
   never orders a pickup) → print and apply → **Připraveno k vyzvednutí**.
4. **Expedice → Svoz**: only this order selected, the day (and a wished window), 1 parcel →
   confirmation (production environment shown) → **Objednat svoz PPL** → wait for **Potvrzeno
   dopravcem** (PPL's order number shown). An uncertain answer: "Zjistit stav u dopravce" only —
   never order again.
5. Physical hand-over to the driver. **Tracking** then shows "Převzato" (PPL pickup code) → the
   order becomes "Převzatá dopravcem"; the manual "Předáno dopravci" only if tracking does not show
   it. The pickup itself never confirms a hand-over.
6. **Doručeno** only by PPL's delivery event (doc 031) — there is no manual delivery.

## 5. Return and the reuse counter

- **Transport back:** AYVO OS has **no return shipment or return label** flow today. Options to verify
  with PPL: a PPL return service/label ordered outside AYVO, or a `TransportOrder` (pickup from any
  address — PPL API, not implemented in AYVO). Either way the same crate with the same QR comes back
  to CZ-PREROV-01; nothing new is labelled.
- **Return receipt** at CZ-PREROV-01: scan the crate (allowed only for its `DELIVERED` cycle →
  `RETURNED`), then each bottle: the individual identification writes `SORTED` → **counter 0 → 1**
  per bottle (a defective one counts too); "Vyprázdněno" closes the cycle.
- **Po mytí** (doc 050): `RETURNED → READY_FOR_REUSE`, pump closed as `CLEANING_REQUIRED`, no stock
  movement — **the counter stays 1**.
- **Later use at the same site:** the crate QR can start a new cycle after `CLOSED`. A
  `READY_FOR_REUSE` bottle cannot enter a crate yet (`NOT_PLACEABLE_YET`; R3 not built) — the bottle QR
  stays valid and waits for R3.

## 6. What the run proves — and what not

Proves (variant A): real PPL label, real pickup order, tracking pickup and delivery, the return
identification (0 → 1) and "Po mytí" (no increase), with the same QR identities. Does **not** prove:
an empty-packaging transport (variant B), a return flow inside AYVO (none exists), bottle refill
(R3).

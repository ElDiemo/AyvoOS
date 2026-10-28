# 042 — Finance: zjednodušená navigace a přehled (UI)

Status: **zadání majitele 2026-10-28** („dobre udelej“), navazuje na audit
`UI-REVIEW-CODEX-20261028` (UI-01–03) a nahrazuje dosavadní plochou navigaci Financí (7 záložek).
Jen uživatelské rozhraní a dvě úzká čtecí rozšíření kontraktu (§3). Nemění finanční pravidla,
oprávnění ani jejich přiřazení, nevystavuje ostré faktury, nevolá banku a nespouští žádné
zpracování. Umístění v navigaci je orientace, **ne autorizace**: každá stránka i API kontrolují
oprávnění samy.

## 1. Mapa rout

Hlavní navigace Financí má pět položek. Všechny dosavadní URL zůstávají platné (záložky prohlížeče
fungují dál); novou URL má jen Přehled.

| #   | Hlavní položka    | Podzáložky (uvnitř stránky)                            | URL                                                                        | Oprávnění (beze změny)                           |
| --- | ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Přehled           | —                                                      | **`/finance`** (nová)                                                      | kterékoli oprávnění Financí; každý blok své      |
| 2   | Faktury hotelům   | Faktury · Smlouvy a ceny                               | `/finance/invoices` (+ `/new`, `/[number]`), `/finance/billing` (+ detail) | `finance:invoices_read` / `finance:billing_read` |
| 3   | Přijaté doklady   | —                                                      | `/finance/documents` (+ `/new`, `/take-over`, `/[code]`)                   | `finance:documents_read`                         |
| 4   | Banka a platby    | Pohyby z banky · Platby a přiřazení                    | `/finance/bank`, `/finance/payments`                                       | `finance:bank_read` / `finance:invoices_read`    |
| 5   | Pro účetní        | —                                                      | `/finance/exports` (+ `/[code]`)                                           | `finance:documents_read`                         |
| —   | Nastavení Financí | odkaz stranou navigace, ne rovnocenná pracovní záložka | `/finance/settings/company`                                                | `finance:issuer_manage` (ADMIN)                  |

- Hlavní položka je aktivní na všech svých URL (i na detailech); vede na první podzáložku, kterou
  uživatel smí otevřít.
- Modul Financí v levé navigaci vede na Přehled (dříve na Doklady).
- Návrat (breadcrumb „←“) na detailech vede na seznam své podzáložky.

## 2. Dostupnost dat (bez druhého zdroje pravdy)

| Údaj                                              | Zdroj                                                               | Omezené načtení      |
| ------------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| Doklady k doplnění                                | `GET documents?incomplete=true` → `total` (existující, stránkované) | ano                  |
| Stav banky (připojení, poslední načtení)          | `GET bank/status` (existující)                                      | ano                  |
| Naše firma a výchozí účty nastaveny               | `GET issuer` (existující, jen `finance:issuer_manage`)              | ano                  |
| Nezaplacené / po splatnosti (počet, zbývá)        | **chybí** — `GET invoices` vrací všechny faktury                    | ne → §3a             |
| Platby k posouzení (nepřiřazené / změněné bankou) | **chybí** — `GET payments` vrací všechny platby                     | ne → §3a             |
| Odběratelé / smlouvy založeny                     | **chybí omezeně** — seznamy vracejí všechny záznamy                 | ne → §3c             |
| Faktura → přiřazené platby                        | `GET invoices/:number` → `allocations[].paymentCode` (existující)   | ano                  |
| Platba → faktury                                  | `GET payments` → `allocations[].invoiceNumber` (existující)         | ano (stránka plateb) |
| Smlouva → související faktury                     | **chybí** — kód smlouvy je jen v řádcích detailu faktury            | ne → §3b             |

Nula se ukazuje jen tam, kde ji server opravdu spočítal. Blok, na který uživatel nemá oprávnění
nebo jehož zdroj neodpověděl, říká „nedostupné“ — nikdy 0.

## 3. Úzká rozšíření kontraktu (jen čtení)

**a) `GET /api/admin/finance/invoices/overview`** (`finance:invoices_read`): souhrny počítané
v databázi agregací, bez načtení seznamu —

```
{ invoices: [{ currency, open: { count, remaining }, overdue: { count, remaining } }],
  paymentsToReview: number, paymentsChangedAtBank: number }
```

Platné (nestornované) TEST faktury; zbývá = celkem − součet přiřazení (stejná pravidla jako
`paymentState` seznamu, splatnost podle `dueOn` a dnešního dne v Praze jako dosud). Platby
k posouzení = platby s nepřiřazenou částkou (stav ≠ `ALLOCATED`). **Zvlášť** `paymentsChangedAtBank`
= zaznamenané platby, jejichž pohyb banka později změnila (`bankChangedSinceRecorded`, i když je
platba celá přiřazená — review FIN90-R1); Přehled je ukazuje jako samostatné varování, aby žádná
z obou definic neschovala tu druhou. Nic se nepřepárovává ani nepřepisuje. Nic nezapisuje.

**b) `GET /api/admin/finance/invoices?agreement=BA-000001`** (`finance:invoices_read`): volitelný
filtr existujícího seznamu na faktury, jejichž řádek odkazuje na smlouvu (jednoznačná vazba
`invoice_lines.agreement_id`, nejvýš jedna faktura za smlouvu a měsíc). Bez filtru se seznam
nemění. Detail smlouvy ukáže tyto faktury jen uživateli s `finance:invoices_read`.

**c) `GET /api/admin/finance/billing/summary`** (`finance:billing_read`, review FIN90-R2): jen
počty `{ customers, agreements }` spočítané v databázi — Přehled podle nich ukazuje kroky nastavení,
aniž by načítal seznamy. Nedostupný zdroj = „nedostupné“, ne nula.

Žádný odhad z textu, jména nebo variabilního symbolu.

## 4. UI-01–03

- **UI-01 návaznost:** Přehled ukazuje další krok podle skutečného stavu (naše firma a účet →
  odběratel → smlouva hotelu → náhled faktury) s odkazy podle oprávnění; nikdy neblokuje práci.
  Prázdné smlouvy nabízejí „Založit odběratele“ (otevře existující formulář), prázdná nová faktura
  odkazuje na smlouvy. Nic se nezakládá automaticky.
- **UI-02 pravdivé texty banky a plateb:** pohyby z banky = co se načetlo z banky; platby =
  přiřazení k fakturám; obě podzáložky na sebe navazují; u tlačítek je zřejmé, co čte banku a co
  zpracuje již načtené pohyby. TEST/PRODUCTION oddělení a varování zůstávají viditelná.
- **UI-03 kompaktnost:** hledání viditelné, pokročilé filtry sbalené; menší prázdné stavy s dalším
  krokem; nástroje DEV simulace v sbaleném bloku pod seznamem plateb.

## 5. Mimo rozsah

Nové externí služby, spojení procesů nebo schémat, změny oprávnění, ostré vystavení, automatické
platby, bankovní synchronizace, Obchod (UI-04), navigace Skladu (UI-05) a vzhled sdíleného
sidebaru (samostatný PR).

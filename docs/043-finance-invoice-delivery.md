# 043 — Finance: doručování PDF faktury e-mailem (návrh ke schválení)

Status: **návrh, nic není postaveno** (zadání majitele 2026-10-30). Přidává tabulky a oprávnění,
proto čeká na schválení modelu majitelem (CLAUDE.md, „Domain models need owner approval“). Ostré
faktury a automatické e-maily na PROD zůstávají blokované do potvrzení účetních pravidel
(doc 040 §7). Tento dokument nic z toho nepovoluje.

## 1. Co se řeší

Odeslat **existující** PDF faktury (doc 040 §9: uložené, ověřené otiskem) odběrateli přes schválený
Google relay. Faktura se nikdy nepřepočítává ani nepřegeneruje. Opakování nikdy nesmí způsobit
druhé odeslání, o kterém nikdo neví.

## 2. Proč nelze slíbit „přesně jednou“

SMTP nemá idempotenci: když spojení spadne po odeslání dat a před odpovědí, nikdo neví, zda relay
zprávu přijal. Proto stejný princip jako tisková fronta (doc 030, `UNCERTAIN` se nikdy neopakuje
samo):

- **nejvýš jedno automatické odeslání** každého doručení;
- nejistý výsledek je viditelný stav, o dalším pokusu rozhodne člověk s důvodem.

## 3. Navržený model

**`invoice_deliveries`** — jeden záznam na jeden záměr odeslat:

| Sloupec                                             | Význam                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `invoice_id`                                        | faktura; soubor se bere z jejího `pdf_storage_key` a kontroluje `pdf_sha256` |
| `recipient`                                         | adresa zmrazená při založení (z verze odběratele `billing_email`)            |
| `customer_version`                                  | verze odběratele, ze které adresa pochází                                    |
| `template_version`                                  | verze textu v kódu                                                           |
| `message_id`                                        | pevné `Message-ID`, stejné i při ručním opakování                            |
| `state`                                             | viz §4                                                                       |
| `attempt_of`                                        | u ručního opakování odkaz na předchozí nejisté nebo neúspěšné doručení       |
| `request_id`                                        | idempotence založení (unikátní)                                              |
| `requested_by`, `requested_by_name`, `requested_at` | kdo a kdy                                                                    |

**`invoice_delivery_events`** — append-only: změny stavu, čas, kód chyby relay (bez obsahu zprávy).

DB invarianty:

- nejvýš jedno živé doručení (`QUEUED`, `SENDING`) na fakturu (částečný unikátní index);
- `SENT` je konečný stav;
- zrušenou fakturu nelze zařadit (trigger);
- TEST faktura jen mimo produkci.

## 4. Stavy

```
QUEUED → SENDING → SENT
                 → FAILED     (relay odmítl jednoznačně před přijetím: nic nedoručeno)
                 → UNCERTAIN  (výpadek uprostřed nebo přerušený proces: výsledek neznámý)
```

- **Zápis `SENDING` se potvrdí v transakci před otevřením SMTP.** Proces, který spadne, tedy zanechá
  `SENDING`.
- **Přebírání:** po uplynutí lhůty se takový záznam změní na `UNCERTAIN`, **nikdy zpět na `QUEUED`**.
- **Jeden odesílatel na záznam:** `SELECT … FOR UPDATE SKIP LOCKED` nad frontou, takže souběh dvou
  procesů neodešle dvakrát.
- **Ruční opakování** `FAILED` / `UNCERTAIN`: nový záznam s `attempt_of`, důvodem a vlastním
  oprávněním. U `UNCERTAIN` UI výslovně varuje, že odběratel mohl zprávu dostat. Stejné `Message-ID`
  pomůže poštovním klientům duplikát poznat, ale nezaručuje to.

## 5. Hranice a provoz

- **Vlastní přenos ve Finance:** Finance nesmí importovat moduly jádra (ADR 0039). Volba transportu
  stejná jako u přihlášení (`google-relay` bez přihlašovacích údajů, `memory` jen v testech); čistou
  funkci s volbami SMTP je potřeba přesunout do `common`. Odesílá se až po ověření otisku PDF.
- **Síť:** Finance potřebuje odchozí 587 na relay. Na PROD je to změna host guardu a IPv4 allowlistu
  (Codex), součást až ostrého zapnutí.
- **Tři nezávislé pojistky pro PROD:**
  1. `FINANCE_INVOICE_MAIL` nenastaveno = fronta se nezpracovává;
  2. oprávnění;
  3. TEST faktury se v produkci neposílají (a ostré zatím neexistují).
- **DEV:** přenos `memory`; žádný skutečný e-mail. Ověření zachycené zprávy v testech.
- **Běžný výpadek relay:** doručení, které prokazatelně neodešlo (spojení se neotevřelo), zůstává
  ve frontě s omezeným počtem pokusů; po jeho vyčerpání `FAILED`.

## 6. Oprávnění a UI

- `finance:invoices_send` (nové, migrace v jádře, ADMIN).
- Detail faktury: stav doručení a historie, akce „Odeslat“ se zobrazenou adresou. V seznamu faktur
  stav doručení.
- Nikdy automaticky po vystavení: odeslání je samostatná akce, dokud majitel nerozhodne jinak.

## 7. Testy (po schválení, syntetická data, přenos `memory` a falešné SMTP)

- Jedno odeslání obsahuje přesně uložené PDF (otisk).
- Opakovaný požadavek se stejným `request_id` neodešle znovu.
- Dvě souběžná zpracování téhož záznamu: jedna zpráva.
- Pád po `SENDING`: `UNCERTAIN`, žádné automatické opakování.
- Odpověď relay 4xx/5xx před přijetím: `FAILED`; odpojení po `DATA`: `UNCERTAIN`.
- Ruční opakování vyžaduje důvod a oprávnění a odkazuje na předchozí záznam.
- Poškozené PDF (jiný otisk): nic se neodešle.
- Zrušená faktura: odmítnuto. S `APP_ENV=production`: odmítnuto.

## 8. Rozhodnutí majitele a účetní

1. Schválení modelu v §3 a oprávnění v §6.
2. Odesílatel (`system@ayvo.co`, nebo jiná adresa pro fakturaci) a text e-mailu (doc 040 §7.8).
3. Jedna adresa na odběratele, nebo víc (kopie)?
4. Odesílat ručně, nebo automaticky po vystavení? Návrh: ručně, dokud nejsou potvrzená účetní pravidla.

# 043 — Finance: doručování PDF faktury e-mailem

Status: **model schválil majitel 30. 10. 2026 („ano jedem“), implementováno pro TEST faktury se
simulovaným SMTP.** Ostré faktury a automatické e-maily zůstávají blokované do potvrzení účetních
pravidel (doc 040 §7). Skutečné doručení přes relay je až kontrolovaný test po review a schváleném
nasazení DEV, jen na odsouhlasenou adresu.

## 0. Rozhodnutí majitele (30. 10. 2026)

- Evidence `invoice_deliveries`, `invoice_delivery_events`, oprávnění `finance:invoices_send` (ADMIN).
- Odesílá se ručně, na jednu adresu `billing_email` z aktuální verze odběratele; adresu uživatel vidí
  předem a požadavek ji obsahuje. Změněná adresa: `RECIPIENT_CHANGED`, nikdy tichá náhrada.
- Odesílatel i Reply-To: `AYVO Billing <invoice@ayvo.co>`, pevně v kódu. Autentizační e-maily dál
  `system@ayvo.co`.
- Jazyk e-mailu je jazyk faktury, včetně textů ze snímku (doc 040 §12). Starší doklad bez jazyka se
  neodesílá (`LANGUAGE_MISSING`).
- `SENT` znamená přijetí relayem, nikdy potvrzené doručení do schránky; UI to říká slovy.
- `UNCERTAIN` se samo neopakuje. Ruční opakování: `finance:invoices_send`, důvod a potvrzené
  varování před duplicitou. Opakuje se poslední `FAILED` nebo `UNCERTAIN` pokus, se stejným `Message-ID`.

Náhledy (syntetická data): `docs/screenshots/finance/finance-invoice-mail-{cs,en,de}.png`,
`finance-delivery-{before,uncertain,sent}-*.png`. Text e-mailu v `invoice-texts.ts` je návrh ke
kontrole majitelem.

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

### Síť a nasazení (DEV a PROD stejně)

- **Žádná změna sítě ani host guardu není potřeba.** Finance je na obou prostředích na mostu `edge`
  a sítích `finance-db`; host guardy (`DOCKER-USER`) filtrují jen provoz vstupující z veřejného
  rozhraní a odchozí spojení kontejnerů pouštějí. Povolené IP DEV a PROD jsou na straně relay.
  Toto vychází z konfigurace v repozitáři; živě to ověří až kontrolovaný test.
- **Omezení odchozího provozu Finance není součástí:** `edge` dnes nemá filtr podle portu. Není to
  rozšíření oproti stávajícímu stavu.
- **`deploy/{dev,prod}/compose.invoice-mail.yml`** přidávají jen tři proměnné do kontejneru Finance.
  Liší se jen doménou pro EHLO. Nasadí se jen s `FINANCE_INVOICE_MAIL`; kontrola je společná
  (`scripts/lib/invoice-mail.sh`).
- **DEV bez skutečné pošty:** `FINANCE_INVOICE_MAIL=simulation` neotevře žádné spojení, stav v UI
  prochází stejným kódem. V produkci ji odmítne aplikace i nasazení.
- **Kontrolovaný test (po review a schváleném nasazení DEV):** `google-relay` a
  `FINANCE_MAIL_TEST_RECIPIENTS` s odsouhlasenou adresou. Na PROD se TEST faktura neodešle.

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

## 8. Jak se rozhoduje o výsledku

Vše neznámé je `UNCERTAIN`. Opakovatelné (`QUEUED`, nejvýš 5 pokusů, pak `FAILED`) je jen to, co
prokazatelně neodeslalo nic: spojení se nenavázalo (`syscall connect`, DNS, TLS) nebo odpověď 4xx.
Odpověď 5xx je `FAILED`. Spadlé spojení po navázání je vždy `UNCERTAIN`: nodemailer u něj hlásí
`command: CONN` i po zapsání zprávy, proto se z tohoto pole nikdy nerozhoduje (zachytil to test se
simulovaným relayem).

## 9. Limity

Jedna zpráva naráz na proces, nejvýš 5 za kolo, spojení se neudržuje. PDF nejvýš 10 MiB, kontrola
otisku před odesláním. Odeslání má lhůtu 60 s, rezervace záznamu 120 s. Logy jen id a stav, nikdy
adresa ani zpráva. Reálný relay vyžaduje `FINANCE_MAIL_EHLO_NAME` a `FINANCE_MAIL_TEST_RECIPIENTS`.
Bez `FINANCE_INVOICE_MAIL` se nic nezařadí ani neodešle. Síť a nasazení: samostatný diff (§5).

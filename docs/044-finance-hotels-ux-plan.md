# 044 — Finance a Hotely: návrh malých UX dodávek

Status: **návrh; pořadí a implementaci v pracovních větvích schválil majitel 30. 10. 2026.** Bez
nových tabulek, migrací a obchodního modelu. Merge a nasazení schválené nejsou. Cesta: nezávislé review
→ DEV → přijetí majitelem → stejný commit PROD. Mapa vychází z průchodu kódem na `b060802`.

## 1. Pevné hranice

- Finance vlastní firmy (plátce) a smlouvy, jádro hotely. Žádná kopie, žádné čtení cizího schématu.
- Hotel se zakládá jen v Hotelech; pokoje k fakturaci jsou jen ve smlouvě.
- Jedna firma může platit za více hotelů. Plátce není automaticky vlastník ani provozovatel; nový model
  skupin nebo provozovatelů se nepřidává.
- Stránka hotelu čte Finance jen omezeným voláním přes kontrakt. Výpadek ukáže jen panel „Fakturace
  dočasně nedostupná“, nikdy falešnou nulu ani „smlouva neexistuje“. Hotel a logistika běží dál.
- Oprávnění se nemění a každá akce je dál kontrolovaná na serveru. Skrytý odkaz není ochrana.
- #92–#98 se nemění; dodávky jdou až po nich, nebo po domluvě s review.

## 2. Mapa rout a práv

Stávající routy beze změny práv, pokud není uvedeno jinak.

| Routa                                        | Stav       | Čtení                      | Změna                      |
| -------------------------------------------- | ---------- | -------------------------- | -------------------------- |
| `/hotels/[code]`                             | úprava     | stávající jádro            | `hotels:manage`            |
| `/hotels/new`                                | text       | `hotels:manage`            | `hotels:manage`            |
| `/finance/billing?hotel=<id>&from=hotel`     | nová volba | `finance:billing_read`     | `finance:billing_manage`   |
| `/finance/billing` (jen smlouvy)             | úprava     | `finance:billing_read`     | `finance:billing_manage`   |
| `/finance/billing/agreements/[code]`         | úprava     | `finance:billing_read`     | `finance:billing_manage`   |
| `/finance/billing/customers`                 | nová       | `finance:billing_read`     | `finance:billing_manage`   |
| `/finance/billing/customers/[code]`          | úprava     | `finance:billing_read`     | `finance:billing_manage`   |
| `/finance/settings/prices`                   | nová       | `finance:billing_read`     | `finance:billing_manage`   |
| `/finance/settings/company`                  | text       | `finance:issuer_manage`    | `finance:issuer_manage`    |
| `/finance/invoices?agreement=<code>`         | úprava     | `finance:invoices_read`    | žádná                      |
| `/finance/invoices/[number]`                 | úprava     | `finance:invoices_read`    | dle akce                   |
| `/finance/payments?state=&changed=&q=&page=` | úprava     | `finance:invoices_read`    | žádná                      |
| `/finance/payments/[code]`                   | nová       | `finance:invoices_read`    | `finance:payments_manage`  |
| `/finance/exports`                           | text       | `finance:documents_read`   | `finance:exports_manage`   |
| `/finance/documents/new`                     | úprava     | `finance:documents_manage` | `finance:documents_manage` |
| `/warehouse/suppliers`                       | beze změny | stávající jádro            | stávající jádro            |

**Ceník nesmí pod `/finance/settings/company`:** ta stránka vyžaduje `finance:issuer_manage`, ceník
`finance:billing_read` a `finance:billing_manage`. Proto vlastní routa v Nastavení Financí, jediný
editor, stejná práva. `/finance/billing` na ni jen odkáže.

**Návrat:** `from=hotel` je pevná hodnota, cíl se skládá ze smlouvy. Žádná volná návratová URL.

## 3. Dodávky

Každá je samostatné PR s vlastními testy a snímky 1440, 390 a 320.

### U1 — Pravdivé texty (bez API)

- `/hotels/new`: pryč „Smlouvy, fakturace… zatím nejsou“; nově, že smlouvu a fakturaci vede Finance a
  naváže se na tento hotel.
- `/finance/settings/company`: vystavitel a výchozí účet jsou potřeba i pro TEST faktury
  (`ISSUER_NOT_READY`). Kontrola se nemění, oddělí se od pravidel účetní pro ostré vystavení.
- `/finance/exports`: export dnes obsahuje přijaté doklady, ne vydané faktury. Do předání se TEST faktury
  nepřidávají.

### U2 — Hotel → smlouva → faktury

- Panel „Smlouva a fakturace“ na kartě hotelu: plátce, platná smlouva, fakturované pokoje, cena se
  zdrojem a měnou, splatnost a faktury se stavem úhrady.
- Data z Finance přes nový čtecí endpoint `GET billing/hotel/:hotelId`, s jasným měsícem platnosti.
  Podmínky počítá stávající výpočet platných podmínek, web nic nepočítá.
- Faktury se filtrují přesnou vazbou řádku na hotel; souhrnná faktura stejné firmy je označená.
- Oprávnění se hodnotí zvlášť: smlouva `finance:billing_read`, faktury `finance:invoices_read`.
- `hotelDetailSchema` dostane `id` (čistě doplňující). Volání má pevný časový limit, chyba končí v panelu.
- Odkazy `/finance/billing?hotel=<id>` a zpět na hotel: založení smlouvy s předvybraným hotelem, výběr
  plátce nebo založení jednoho nového.

### U3 — Rozdělení `/finance/billing`

Podhledy Smlouvy a Plátci, ceník přesunutý (viz §2). Plátce se popisuje jako firma, ne hotel, a ukazuje
své hotely. Staré odkazy `?new=` přesměrují na odpovídající formulář.

### U4 — Platby (samostatné PR s omezeným API)

- `GET payments`: `state`, `changed`, `q` (kód, VS, přesná částka), stránkování se serverovým limitem.
  Výpis faktur se přestane načítat celý; hledání otevřených faktur je omezené.
- Přehled odkazuje zvlášť na „K posouzení“ a „Změněno bankou“.
- Kompaktní sloupce (datum, částka, VS, protistrana, stav), jeden stav, UUID jen v detailu.
- `/finance/payments/[code]`: přiřazení a historie. Přiřazovací pravidla beze změny.

### U5 — Odesílání: simulace, nebo skutečný test (po #97 a #98, po domluvě)

- `GET deliveries` vrátí režim z konfigurace serveru: simulace, nebo relay. Nové pole, žádná tabulka.
- Simulace: „zkušební odeslání, nic neopustí systém“. Relay na DEV: „skutečný testovací e-mail, jen na
  povolenou adresu“.
- Upravit varování nahoře a přegenerovat snímky. **Snímky `finance-delivery-*` v #97 vznikly před
  poslední úpravou textu a starou větu stále ukazují.**
- `SENT` dál znamená přijetí serverem, ne doručení.

### U6 — Detaily: nejdřív současnost (P2)

- Plátce: aktuální souhrn a „Upravit“ nahoře, historie sbalená.
- Faktura: stav, zbývá, PDF a akce nahoře; historie odeslání, audit a otisk v rozbalení.
- `UNCERTAIN` i potvrzení duplicity zůstávají vždy viditelné nahoře.

### U7 — Doklad → dodavatel (P2)

Odkaz místo textu „Sklad → Dodavatelé“ do jediného registru; jen s oprávněním k němu, jinak srozumitelná
věta. Rozepsaný doklad přežije návrat. Žádné povinné naskladnění. Přílohu nelze uchovat v prohlížeči, UI
to řekne předem.

### U8 — Vstupy a provozovna (P2)

- Výběr země a měny místo volného textu; ukládané hodnoty beze změny.
- Český desetinný vstup převáděný na text bez čísel s plovoucí čárkou; neplatný vstup se odmítne, ne opraví.
- Rozsah provozovny se jen čitelně popíše podle kontraktu a oprávnění, žádné nové klientské filtrování.

## 4. Pořadí a závislosti

U1 a U4 mohou stát na `main`, ostatní až po #96–#98 (stejné formuláře a detail faktury). Navrhované
pořadí: U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8.

## 5. Akceptace

| #   | Scénář                                                                                                               | Ověří                       | Dodávka                    |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------- |
| A1  | Hotel → smlouva → faktura → platba klikáním, se zpětnými odkazy a bez ručního hledání                                | Playwright, syntetická data | U2, U4                     |
| A2  | Dva hotely s jednou firmou: jeden plátce, dvě smlouvy, vlastní pokoje a faktury; úprava firmy nezmění vydané faktury | API + Playwright            | U2, U3                     |
| A3  | Historické faktury: stejné bajty PDF a snímek před i po                                                              | API test                    | každá dotýkající se faktur |
| A4  | Účet bez práv Financí: hotel bez karty, přímé routy a API odmítnuté, žádný odkaz do Forbidden                        | Playwright + API            | U2, U3                     |
| A5  | Finance neběží: detail hotelu, objednávky a logistika fungují; Finance ukáže „Teď nedostupné“                        | `workflow-finance-outage`   | U2                         |
| A6  | Jeden editor ceníku, stejná práva; čtenář jen čte                                                                    | Playwright + API            | U3                         |
| A7  | Platby: filtry, limit na serveru, dva odkazy z Přehledu dávají různé výsledky                                        | API + Playwright            | U4                         |
| A8  | Simulace a skutečný test jsou slovy odlišené; `UNCERTAIN` a varování vždy viditelné                                  | Playwright                  | U5, U6                     |
| A9  | 1440, 390, 320 bez vodorovného přetečení; celý průchod jen klávesnicí, viditelný fokus, popsaná pole                 | Playwright                  | všechny s UI               |

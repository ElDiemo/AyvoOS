# ADR 0046 — Provize za získané hotely

- **Stav** — Proposed, hranice a zavedení čekají na schválení majitele.
- **Datum** — 2026-11-08.
- **Navazuje na** [Obchod a vlastnictví akvizic](0031-sales-function-and-ownership-scope.md), [samostatné Finance](0039-finance-runtime-unit.md), [návrhy smluv](0043-contract-drafts.md) a [fakturaci hotelů](../040-hotel-billing.md).

## Obchodní pravidla potvrzená majitelem

- Základ tvoří skutečně fakturované pokoje × jednotková cena bez DPH za konkrétní hotel. Pokud ostré faktury později podporují slevu či poměrnou cenu, zdrojem je konečný základ bez DPH uložený na vydaném řádku.
- Výchozí sazba činí 20 % za prvních 24 kalendářních fakturačních období počínaje prvním skutečně fakturovaným měsícem služby. Od 25. měsíce činí 5 %. Sazba se řídí obdobím služby, i když platba přijde později.
- Obchodník může po vydání vidět předpokládanou provizi. K fakturaci jde až po plné úhradě hotelové faktury a schválení měsíčního podkladu.
- Podklad obsahuje výpočet a rozpis. Obchodník, který fakturuje jako dodavatel, vystaví vlastní doklad. AYVO ho může připojit jako přijatý doklad k danému podkladu.

## Odpovědnosti a kontrakt

| Jednotka | Vlastní data a rozhodnutí |
| --- | --- |
| Jádro / Obchod | Vazba získané akvizice, provozního hotelu a obchodníka s účinností od měsíce. Aktér, důvod a audit každé změny. Stávající vlastník akvizice je návrh k potvrzení, změna péče o akvizici sama provizi nemění. |
| Finance | Pravidla provize a schválené sazby s účinností, vydané řádky, skutečné úhrady, výpočet, měsíční podklad, korekce a vazba na přijatý doklad. |
| Interní web | „Obchod → Moje provize“ a „Finance → Provize obchodníků“. Zobrazí výpočet a dokumenty podle oprávnění ověřených serverem. |

- Finance získají vazby hotelů a identitu obchodníka výhradně ze zabezpečeného kontraktu `Finance → Core`. Kontrakt vrací omezený seznam pro požadované hotely a období, včetně verzí. Jádro čte pouze vlastní data.
- Finance nejdřív načtou data kontraktem v omezených dávkách s časovým limitem. Výpočet a uložení schváleného podkladu pak proběhnou ve vlastní databázové transakci s ověřením stavu faktur a úhrad. Každá schválená položka uchová revizi přiřazení a pravidla i podkladový řádek. Pozdější změny se promítnou samostatnou auditovanou korekcí.
- Při nedostupném jádru nelze sestavit nebo schválit nový podklad. Při nedostupných Financích se přehled provizí přepne do stavu nedostupnosti, Obchod funguje dál. Výpočet se spouští na vyžádání po omezených dávkách. Jádro a Finance sdílejí server a PostgreSQL.
- Použijí se stávající procesy a nasazení podle ADR 0001 a 0039. Přímý přístup k tabulkám jiné jednotky by vytvořil závislost na jejím schématu a obcházel její oprávnění.

## První průchod

1. Správce na kartě hotelu potvrdí obchodníka a zdrojovou akvizici. Historie přiřazení je účinná po měsících. Pro existující hotely se přiřazení a začátek potvrdí jednotlivě.
2. Finance sestaví náhled za hotel a fakturované období. Například 80 × 150 Kč = 12 000 Kč bez DPH, provize činí 2 400 Kč při 20 % nebo 600 Kč při 5 %. Výpočet probíhá v přesné desetinné aritmetice, součty se vedou podle měny. Konkrétní zaokrouhlení částky na řádku je součástí implementačního kontraktu k potvrzení.
3. Obchodník vidí vlastní položky. Neuhrazená i částečně uhrazená faktura mají stav „Čeká na úhradu hotelu“. U společné faktury se provize počítá po hotelových řádcích. K fakturaci se uvolní až po plné úhradě společné faktury.
4. Správce schválí měsíční podklad za obchodníka a měnu. Podklad má své ID a rozpis hotelů. Obchodník si ho stáhne v PDF nebo CSV. Opakování schválení stejného požadavku vrátí tentýž výsledek a schválený řádek nelze zahrnout podruhé. Platba obchodníkovi se eviduje samostatně po připojení jeho dokladu.
5. Storno před schválením vyřadí položku z podkladu. Pozdější storno či dobropis s doloženou vazbou na původní řádek zakládá korekci v dalším podkladu. Korekce zachová původní sazbu a vazbu na zdroj.

## Přístupy

- Správce spravuje přiřazení, pravidla a podklady. Obchodník čte výhradně vlastní položky, schválené podklady a údaje nutné k jejich ověření. Stávající role Obchodník nedostane obecné čtení faktur ani přijatých dokladů.
- Stejná kontrola platí pro seznam, detail i export. Pokus o čtení cizího podkladu se odmítne i při přímém volání API.

## Zavedení a akceptace

1. Samostatný PR v jádru přidá přiřazení obchodníka a čtecí kontrakt pro Finance. Začne na syntetických datech.
2. Samostatný PR ve Financích přidá výpočet a čtecí náhled. Na DEV používá jasně označená syntetická data. Na PROD mohou k fakturaci jen skutečně vystavené a plně uhrazené doklady. V současnosti je ostré vystavení v modelu faktur otevřený předpoklad.
3. Samostatný PR přidá měsíční schválení a exporty. Databázové migrace mají být rozšiřující. Před prvním zápisem se ověří návrat staré aplikace proti rozšířenému schématu. Podmínky návratu po schválení podkladů se doloží v release postupu.
4. Před zákaznickým provozem ověřit na DEV dvě osoby a společnou fakturu více hotelů, 24. a 25. měsíc, pozdní úhradu, částečnou úhradu, více měn, změnu přiřazení, storno a souběžné schválení. Prověřit také odpojení Financí či jádra a odmítnutí přístupu k cizímu PDF/CSV.

První uživatelsky ověřitelná dávka je přiřazení obchodníka na kartě hotelu a read-only náhled v „Moje provize“. Doklad k fakturaci se povolí až s měsíčním schválením a prokázanou ostrou fakturací.

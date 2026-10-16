# 027 — Výroba: Práce · Evidence · Nastavení (návrh UI, issue #11)

Status: **proposal for the owner's confirmation** (2026-10-16). Navigation and onboarding of the
Production module only (issue #11 UI-08/12/13/14/15/16). It changes no consumption, state,
permission or role assignment; Warehouse and System administration stay as they are; dispatch
and returns get no tabs yet.

Podklad:

- main `2f250d9`, k tomu rozpracované PR #24 (A4) a #25 (A5);
- review z 16. 10. v issue #11.

Jde o **návrh k potvrzení**, nikoli o implementaci. Nemění odpisy, stavy, oprávnění ani jejich přiřazení.

### 1. Které nálezy jsou opravené a které ne (kód main + #24/#25)

| Nález                                      | Stav       | Poznámka                                                                                                   |
| ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------- |
| UI-15 role jen pro lepení                  | **platí**  | `navigation.ts`: modul ani záložka Pracoviště nepočítají s `production:label_apply` (stránka ano)          |
| UI-14 fokus po zavření menu                | **platí**  | A3/A4 opravily jen fokus po dialogu nevyřešené fronty a po načtení plnicí stanice (#24) – globální menu ne |
| UI-08 aktivní záložka mimo výřez na mobilu | **platí**  |                                                                                                            |
| UI-16 zastaralé texty o odpisu             | **platí**  | po A4 má text říct: nalepení = tělo + etiketa, naplnění = kapalina + pumpička                              |
| UI-17 „V pořádku“ při nulové zásobě        | platí      | mimo Výrobu, malá oprava textu                                                                             |
| UI-12/13                                   | návrh níže |                                                                                                            |
| UI-06/09/10/11/18/19                       | beze změny | nejsou součástí tohoto návrhu                                                                              |

A4/A5 nebudu kvůli tomu rozdělávat: jejich větve zůstanou beze změny.

### 2. Strom navigace (jen uvnitř modulu Výroba; URL zůstávají)

```
Výroba
├─ ▶ Pracovat na pracovišti      /production/station          (výrazné tlačítko, ne záložka mezi ostatními)
│     QR pracoviště určí lepení / plnění; plocha = aktuální krok, produkt, bedna, šarže, Obsah/Naplněno
├─ Evidence
│   ├─ Bedny                     /production/crates (+ detail, Lahve mimo bednu /production/crates/outside)
│   │     detail: obsah, historie, tiskové úlohy QR; „Opravy vedoucího“ jako oddělená sekce detailu
│   └─ Lahve                     /bottles, /batches (+ historie, série, tiskové úlohy etiket)
└─ Nastavení výroby
    ├─ Připravit výrobu          /production/setup  (nové, jen čtení – viz bod 4)
    ├─ Pracoviště a QR           /production/workstations
    ├─ Produkty a receptury      /production/catalog (komponenty, typy beden, schválené designy)
    └─ Designy etiket            /label-templates
```

- **Přehled výroby** (`/production`) zůstane vstupní stránkou modulu. Nahoře bude tlačítko „Pracovat na pracovišti“, pod ním počty rozpracovaných a připravených beden z A5.
- **Sklad** zůstává samostatný.
- **Uživatelé, role a provozovny** zůstávají ve Správě systému.
- **Expedice a Příjem vratek** zatím nedostanou žádnou záložku.
- **Mobil:** místo sedmi rovnocenných záložek budou tři skupiny s nadpisy. Aktivní položku stránka posune do výřezu (UI-08) a skupinu Práce nahradí tlačítko.
- **Technicky:** ve `navigation.ts` přibude `group` (`work | records | setup`) a viditelnost stránky podle **libovolného** z oprávnění (`anyOf`), stejně jako stránky samy kontrolují přístup na serveru (UI-15). Nebude to zvláštní natvrdo přidaný odkaz.

### 3. Přístupy (existující oprávnění, beze změny přiřazení)

Role určuje činnost; provozovna a sklad uživatele určují, která data vidí (API to kontroluje u každého požadavku, skrytí v UI není hranice).

| Sekce / akce                                                       | Oprávnění (server)                                                     | Operátor výroby | Vedoucí výroby | Správce (ADMIN) |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | :-------------: | :------------: | :-------------: |
| Pracovat na pracovišti – lepení                                    | `production:label_apply`                                               |        ✓        |       ✓        |        ✓        |
| Pracovat na pracovišti – plnění, změna šarže, Hotovo               | `production:fill`                                                      |        ✓        |       ✓        |        ✓        |
| Vynucené převzetí obsazeného pracoviště                            | `production:session_takeover`                                          |        –        |       ✓        |        ✓        |
| Evidence: Bedny, detail, Lahve mimo bednu                          | `crates:read`                                                          |    ✓ (čtení)    |       ✓        |        ✓        |
| Evidence: registrace beden a tisk QR beden                         | `crates:register`                                                      |        –        |       ✓        |        ✓        |
| Opravy vedoucího (vyjmout, doplnit, přeložit, vrátit, zrušit oběh) | `production:cycle_correct` (#24)                                       |        –        |       ✓        |        ✓        |
| Evidence: Lahve, série, historie                                   | `production:read`                                                      |        ✓        |       ✓        |        ✓        |
| Tisk etiket lahví                                                  | `production:labels_print`                                              |        ✓        |       ✓        |        ✓        |
| Založení identit lahví                                             | `production:bottles_create`                                            |        –        |       ✓        |        ✓        |
| Nastavení: Pracoviště a QR                                         | `production:workstations_manage`                                       |        –        |       ✓        |        ✓        |
| Nastavení: Produkty a receptury (čtení)                            | `catalog:read`                                                         |        ✓        |       ✓        |        ✓        |
| Nastavení: úpravy produktů, komponent, schválení designu           | `catalog:product_manage`                                               |        –        |       ✓        |        ✓        |
| Nastavení: aktivace receptury                                      | `catalog:recipe_approve`                                               |        –        |       ✓        |        ✓        |
| Nastavení: Designy etiket – čtení / úpravy                         | `production:read` / `production:templates_manage`                      |      čtení      |     čtení      |        ✓        |
| Připravit výrobu (přehled)                                         | kterékoli z `production:workstations_manage`, `catalog:product_manage` |        –        |       ✓        |        ✓        |

- **Skupina Nastavení** se ukáže, jen pokud má uživatel aspoň jedno z jejích oprávnění.
- **Operátor uvidí z Nastavení jen čtení katalogu.** Pokud by měl Nastavení skryté úplně, šlo by o změnu jeho role (má `catalog:read`), a tu bez schválení nedělám.
- **Skladové role** vidí ve Výrobě jen Bedny (`crates:read`), jako dosud.

### 4. „Připravit výrobu“ – návrh obsahu

Kontrolní seznam pro **aktivní provozovnu** a zvolený produkt. Bude jen pro čtení a každý řádek povede na existující stránku, pokud má uživatel oprávnění; jinak zobrazí „požádejte vedoucího“.

1. **Provozovna:** vyrábí a má sklad (`PRODUCTION`, sklad provozovny).
2. **Produkt:** je aktivní a má **kompletní aktivní recepturu** – to je trvalé nastavení.
3. **Design etikety:** je pro produkt schválený.
4. **Fyzické bedny:** existují bedny typu z receptury; ukáže se, kolik je prázdných a použitelných.
5. **Pracoviště:** existuje lepicí pracoviště a plnicí pracoviště stejné kategorie; QR se dá vytisknout.
6. **Etikety lahví:** existují vytištěné identity lahví se schváleným designem, které ještě nejsou nalepené.
7. **Zásoby teď** (aktuální stav, žádná rezervace ani záruka na směnu):
   - šarže nových lahví;
   - etikety;
   - šarže kapaliny;
   - pumpičky;
     vždy na skladu příslušného pracoviště.

Seznam vždy rozliší „**receptura je kompletní**“ (body 1–3) od „**teď se dá pracovat**“ (body 4–7) a u každého chybějícího předpokladu napíše konkrétně, co chybí.

**Data:** k tomu přibude jeden **read-only agregační endpoint** (`GET /api/admin/production/readiness`) nad existujícími službami. Neodhaduje se z neúplných dat a nevzniká žádný nový model ani tabulka. Pokud ho nechcete, zúžím přehled na odkazy bez stavu.

### 5. Postup

1. **A4/A5:** čekají na review Codexu (#24, #25). Případné nálezy opravím v nich; jinou práci do nich nepřidávám.
2. **Implementace návrhu:** jeden samostatný PR **z `main` po merge #24 a #25**, tedy nad stabilním základem a bez řetězení na rozpracované větve. Obsah:
   - skupiny navigace a `anyOf` (UI-15);
   - tlačítko Práce;
   - Připravit výrobu;
   - UI-14 fokus po zavření menu na skenovacích stránkách;
   - UI-08 aktivní položka ve výřezu;
   - UI-16 texty.
     Testy: role jen lepení / jen plnění / obě / žádná, mobilní 320/390 px, fokus čtečky po zavření menu a srozumitelné hlášení chybějících předpokladů.
3. **K potvrzení:** prosím potvrďte strom z bodu 2 a obsah bodu 4 (včetně read-only endpointu). Do té doby jen připravuji.

Tento dokument nic nemerguje, nenasazuje ani nemění na DEV.

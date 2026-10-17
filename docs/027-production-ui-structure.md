# 027 — Výroba: Práce · Evidence · Nastavení (návrh UI, issue #11)

Status: **direction confirmed by the owner (2026-10-16)** — Práce / Evidence / Nastavení výroby,
the "Připravit výrobu" overview and a read-only aggregation endpoint that exposes nothing beyond
the user's current permissions and sites. Revision 2 includes the Codex review of PR #26. Not an
approval to merge or deploy.

Implementation in review (2026-10-16, branch `feat/production-ui-structure`): grouped navigation
with the work entry and `anyOf`, catalogue/templates read-only under Evidence without a setup
permission, "Připravit výrobu" with `GET /api/admin/production/readiness`, UI-08, UI-14, UI-16. Navigation and onboarding of the
Production module only (issue #11 UI-08/12/13/14/15/16). It changes no consumption, state,
permission or role assignment; Warehouse and System administration stay as they are; dispatch
and returns get no tabs yet.

Podklad:

- main `2f250d9`, k tomu rozpracované PR #24 (A4) a #25 (A5);
- review z 16. 10. v issue #11.

Návrh nemění odpisy, stavy, výrobní pravidla, oprávnění ani jejich přiřazení.

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

Umístění v navigaci je otázka orientace, **ne autorizace**: o tom, co uživatel smí, rozhoduje
vždy server podle existujících oprávnění, provozovny a skladu. Skrytí nebo přesun položky nikomu
nic neodebírá ani nepřidává.

```
Výroba
├─ ▶ Pracovat na pracovišti      /production/station   (výrazné tlačítko; ANY(label_apply, fill))
│     QR pracoviště určí lepení / plnění; plocha = aktuální krok, produkt, bedna, šarže, Obsah/Naplněno
├─ Evidence
│   ├─ Bedny                     /production/crates (+ detail, Lahve mimo bednu /production/crates/outside)
│   │     detail: obsah, historie, tiskové úlohy QR; „Opravy vedoucího“ jako zřetelně oddělená
│   │     sekce detailu (ne v pracovní ploše, ne vedle skenování)
│   ├─ Lahve                     /bottles, /batches (+ historie, série, tiskové úlohy etiket)
│   └─ Katalog (jen pro čtení)   /production/catalog, /label-templates — referenční pohled pro
│                                uživatele bez správních oprávnění katalogu/šablon
└─ Nastavení výroby               (jen pro uživatele se správním oprávněním některé položky)
    ├─ Připravit výrobu          /production/setup  (nové, jen čtení – bod 4)
    ├─ Pracoviště a QR           /production/workstations
    ├─ Produkty a receptury      /production/catalog (komponenty, typy beden, schválené designy)
    └─ Designy etiket            /label-templates
```

- **Přehled výroby** (`/production`) zůstane vstupní stránkou modulu: nahoře „Pracovat na
  pracovišti“, pod ním počty rozpracovaných a připravených beden (A5).
- Katalog a designy mají **jedny stránky**; navigace je jen zařadí podle toho, zda uživatel smí
  něco spravovat (Nastavení) nebo jen číst (Evidence → Katalog, jen pro čtení). Správní akce
  (formuláře, aktivace, archivace, schválení designu) se zobrazují jen s příslušným oprávněním a
  server je bez něj odmítne jako dosud.
- **Sklad** zůstává samostatný; **uživatelé, role a provozovny** ve Správě systému; **Expedice a
  Příjem vratek** nedostanou žádnou záložku.
- **Mobil:** tři skupiny s nadpisy místo sedmi rovnocenných záložek; aktivní položka se posune do
  výřezu (UI-08); Práce je tlačítko.
- **Technicky:** `navigation.ts` dostane `group` (`work | records | setup`) a `anyOf` oprávnění
  (stejná alternativa jako serverová kontrola stránky, UI-15); zařazení do skupiny je oddělené od
  oprávnění, které stránku zpřístupňuje.

### 3. Přístupy (existující oprávnění, beze změny přiřazení)

Role určuje činnost; provozovna a sklad uživatele určují rozsah dat. API kontroluje oprávnění,
aktivní provozovnu a sklad u každého požadavku; UI jen zobrazuje, co server dovolí.

| Sekce / akce                                                   | Oprávnění (server)                                                     | Operátor výroby | Vedoucí výroby | Správce (ADMIN) |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | :-------------: | :------------: | :-------------: |
| Práce: lepení                                                  | `production:label_apply`                                               |        ✓        |       ✓        |        ✓        |
| Práce: plnění, změna šarže, Hotovo                             | `production:fill`                                                      |        ✓        |       ✓        |        ✓        |
| Práce: vynucené převzetí obsazeného pracoviště                 | `production:session_takeover`                                          |        –        |       ✓        |        ✓        |
| Evidence: Bedny, detail, Lahve mimo bednu                      | `crates:read`                                                          |        ✓        |       ✓        |        ✓        |
| Evidence: registrace beden a tisk QR beden                     | `crates:register`                                                      |        –        |       ✓        |        ✓        |
| Evidence (detail bedny): opravy vedoucího                      | `production:cycle_correct` (#24)                                       |        –        |       ✓        |        ✓        |
| Evidence: Lahve, série, historie                               | `production:read`                                                      |        ✓        |       ✓        |        ✓        |
| Evidence: generování PDF etiket lahví                          | `production:labels_print`                                              |        ✓        |       ✓        |        ✓        |
| Evidence: Katalog a designy etiket – **jen čtení**             | `catalog:read`, `production:read`                                      |        ✓        | (v Nastavení)  |  (v Nastavení)  |
| Nastavení: založení identit lahví                              | `production:bottles_create`                                            |        –        |       ✓        |        ✓        |
| Nastavení: Pracoviště a QR                                     | `production:workstations_manage`                                       |        –        |       ✓        |        ✓        |
| Nastavení: produkty, komponenty, typy beden, schválení designu | `catalog:product_manage`                                               |        –        |       ✓        |        ✓        |
| Nastavení: aktivace receptury                                  | `catalog:recipe_approve`                                               |        –        |       ✓        |        ✓        |
| Nastavení: úpravy designů etiket                               | `production:templates_manage`                                          |        –        |       –        |        ✓        |
| Nastavení: Připravit výrobu                                    | kterékoli z `production:workstations_manage`, `catalog:product_manage` |        –        |       ✓        |        ✓        |

- Operátor tak **čte** katalog i designy etiket (má `catalog:read` i `production:read`) jako
  referenci v Evidenci, ale skupinu Nastavení nevidí — jde o volbu zobrazení, **ne o změnu jeho
  oprávnění**; přímé URL čtení fungují dál, správní akce mu server odmítá jako dosud.
- Skupina Nastavení se ukáže uživateli s aspoň jedním **správním** oprávněním některé její položky.
- Skladové role vidí ve Výrobě jen Bedny (`crates:read`), jako dosud.

### 4. „Připravit výrobu“

Read-only přehled pro **aktivní provozovnu** a zvolený produkt. Každý řádek odkazuje na
existující stránku (je-li k ní oprávnění), jinak „požádejte vedoucího“. Přehled **nic nepovoluje
ani neblokuje**: není to nová brána operací, nezavádí rezervace ani nové podmínky — lepení i
plnění dál posuzuje jen server při každém skenu.

**Trvalé nastavení produktu** (samostatné vlastnosti, ne souhrn):

- provozovna vyrábí (`PRODUCTION`) a má sklad;
- produkt je aktivní;
- **receptura je kompletní** (aktivní verze s kusovníkem lepení i plnění) — jen vlastnost
  receptury, nic víc;
- design etikety je pro produkt schválený.

**Lze začít lepit** (jen předpoklady lepení):

- lepicí pracoviště na provozovně (a jeho QR);
- etikety lahví **připravené k tisku**: identity se schváleným designem s **vygenerovaným PDF**
  (dokončená tisková úloha), dosud nenalepené. Systém neeviduje fyzický tisk ani fyzickou existenci
  štítku — přehled to netvrdí a nabízí odkaz na PDF / tisk; žádný nový povinný scan ani model;
- bedna typu z receptury, prázdná nebo skládající se se stejným produktem a designem;
- zásoby teď na skladu pracoviště: šarže nových lahví, etikety.

**Lze začít plnit** (jen předpoklady plnění — lepení na ně nečeká):

- plnicí pracoviště stejné kategorie (a jeho QR);
- bedny „Čeká na plnění“ nebo „Plní se“ s tímto produktem;
- zásoby teď na skladu pracoviště: šarže kapaliny, pumpičky.

**Stav beden** — skutečné počty podle stavu (Skládá se, Čeká na plnění, Plní se, Připravená) s
odkazem do Evidence → Bedny.

Zásoby jsou vždy **aktuální stav**, ne rezervace ani záruka na směnu.

**Endpoint `GET /api/admin/production/readiness`** (read-only, nad existujícími službami, bez nového
modelu či tabulky):

- vstup: kterékoli z `production:workstations_manage`, `catalog:product_manage`; data jen
  **aktivní provozovny** uživatele (validovaná session, `@OperationalSite()`), sklady jen v jeho
  scopes;
- **každá vracená položka je chráněná vlastním existujícím oprávněním**, které by uživatel
  potřeboval na příslušné stránce: zásoby a šarže jen s `inventory:read` a přístupem ke skladu
  pracoviště; bedny s `crates:read`; pracoviště s `production:workstations_manage`; identity a
  tiskové úlohy s `production:read`; katalog s `catalog:read`;
- bez oprávnění vrátí položka stav **„nedostupné (bez oprávnění)“** — nikdy nulu, nikdy „splněno“,
  bez šarží, množství či jiných podrobností; ceny se nevracejí vůbec;
- žádné nové zpřístupnění dat; kdyby si souhrn nějaké vyžádal, předložím konkrétní rozsah
  vlastníkovi.

Testy: role s a bez `inventory:read` / přístupu ke skladu (žádná množství ani šarže), cizí
provozovna (nic), operátor (endpoint odmítnut), lepení připravené bez kapaliny a pumpiček,
plnění bez etiket, PDF vygenerováno ≠ „vytištěno“.

### 5. Postup

1. A4/A5 (#24, #25): technické review Codexu, opravy, povinné CI; #25 po merge #24 přesměrovat na
   `main` a nechat proběhnout CI. Do A4/A5 se redesign nepřidává.
2. Po schváleném merge A4/A5: **jeden implementační UI PR z aktuálního `main`** podle tohoto
   dokumentu — skupiny navigace a `anyOf` (UI-15), Práce, Evidence s katalogem jen pro čtení,
   oddělené opravy vedoucího, Připravit výrobu + endpoint, UI-14 fokus po zavření menu, UI-08
   aktivní položka ve výřezu, UI-16 texty. Testy: role jen lepení / jen plnění / obě / žádná,
   operátor vs. vedoucí vs. správce, mobil 320/390 px, fokus čtečky po zavření menu, srozumitelná
   hlášení. Bez expedice, vratek a PPL; výrobní pravidla a živá data beze změny.

Tento dokument nic nemerguje, nenasazuje ani nemění na DEV.

## Follow-up: issue #11 review of 17. 10. (UI-20 … UI-24, UI-08)

Orientation only — no production rule, permission or role assignment changed.

- **UI-20 — real sections.** Výroba shows its sections first — Přehled, Práce, Evidence,
  Nastavení výroby (only those with a page the user may open) — and below them only the pages of
  the active section; the section follows the current URL. On a phone the sections are a compact
  2×2 grid (nothing hidden sideways). A plain production operator sees Přehled, Práce and Evidence;
  Nastavení appears only with the existing setup permissions. The separate "work button" row is
  gone (Práce is the section). Modules without groups keep their single strip.
- **UI-08 follow-up.** The page strip re-centres its active page also when the width changes.
- **UI-21 — the next step.** Every missing item of "Připravit výrobu" names its concrete step
  ("Schválit design etikety pro tento produkt", "Založit lepicí pracoviště a vytisknout jeho QR",
  "Připravit QR etikety lahví (PDF)", "Přijmout etikety na sklad" …) linking to the existing page —
  only with the permission that page needs, otherwise "Požádejte vedoucího". Dependencies are
  explained (labels count only with an approved design; crates for filling come from labelling),
  never turned into new gates. The design step opens the product's design section (`#designs`).
  "Pracovat na pracovišti" tells a station manager when the site has no active station yet, with
  the way to create one; others are told to ask the supervisor.
- **UI-22 — identity ≠ bottle.** "Vytvořit lahve" is now "Připravit QR etikety lahví": it creates
  permanent identities and their label PDF, consumes nothing and makes no physical bottle; the
  page lists the three steps (identity + PDF → labelled at the labelling station → filled at the
  filling station). Internal ids, history and the API are unchanged.
- **UI-23 — crate list on a phone.** State counts in one sideways row, the search on the first
  line, crate type and state behind "Další filtry" (open while used): the first crate starts on
  the first screen.
- **UI-24 — corrections set apart.** On the crate detail the supervisor corrections are a
  separate, collapsed section after identity, content, QR printing and history.
- Screenshots (synthetic data, desktop / 390 / 320 px): `docs/screenshots/issue-11-ui-clarity/`.

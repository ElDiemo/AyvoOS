# Fyzická akceptace: Raspberry Pi → Zebra ZD220 DT (zatím neprovedena)

Krátký protokol pro první skutečný tisk. Každý bod je splněn, nebo nesplněn s poznámkou.
Simulátor se nepoužívá. Novou zásilku u PPL lze založit **jen s výslovným souhlasem vlastníka**
(body 4–6 ho potřebují).

**Předpoklady:**

- PR #38 je zrevidovaný, sloučený a nasazený na DEV;
- agent je nainstalovaný podle [README.md](README.md) a hlásí „Ozval se“;
- tiskárna hlásí „Připravena“;
- automatický tisk je zatím **vypnutý**;
- v tiskárně jsou skutečné termoetikety (rozměr si poznamenejte; AYVO OS ho nepředpokládá);
- při ruka je čtečka čárových kódů.

| #   | Krok                                                                                                                                                                                                                                                                                | Očekávaný výsledek                                                                                                                                                                                    | Výsledek |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0   | Body 1–3 posílají soubory přímo do tiskárny: na tu dobu agenta zastavte (`sudo systemctl stop ayvo-print-agent`), po bodu 3 ho znovu spusťte (`sudo systemctl start ayvo-print-agent`).                                                                                             | Během bodů 1–3 netiskne nic jiného.                                                                                                                                                                   |          |
| 1   | **Kalibrace média.** Na Pi: `printf '~JC' \| sudo tee /dev/usb/lp0 >/dev/null` (ZPL příkaz Zebry pro kalibraci média; zařízení podle `preflight.sh`). Pak konfigurační štítek: `printf '~WC' \| sudo tee /dev/usb/lp0 >/dev/null`.                                                  | Tiskárna posune několik etiket a zastaví na začátku další. Konfigurační štítek ukazuje 203 dpi, šířku tisku a délku etikety.                                                                          |          |
| 2   | **Jeden štítek.** Uložený testovací štítek PPL (ZPL z dávky 80256049255, balík **1/3**; ze serveru `/opt/ayvo/ppl-support/2026-10-20-format-change/files/80256049255-203dpi.zpl`) pošlete stejně: `sudo tee /dev/usb/lp0 <80256049255-203dpi.zpl >/dev/null`. Nic se tím nezakládá. | Štítek je celý na jedné etiketě: nezmenšený, neoříznutý a bez posunu přes okraj.                                                                                                                      |          |
| 3   | **Čitelnost.** Načtěte čtečkou hlavní čárový kód štítku z bodu 2.                                                                                                                                                                                                                   | Čtečka přečte `80256049255` (případně s doplňkem PPL). Text je ostrý.                                                                                                                                 |          |
| 4   | **Tři štítky správně přiřazené.** Se souhlasem vlastníka: objednávka se 3 bednami na PPL TEST, „Dokončit a vytisknout 3 štítky“ (automatický tisk zapnout těsně předtím).                                                                                                           | 3 úlohy „Odesláno do tiskárny“. Na každé bedně je štítek s číslem, které AYVO OS ukazuje u **téže** bedny, a s pořadím 1/3, 2/3, 3/3. Ověřte čtečkou proti detailu objednávky.                        |          |
| 5   | **Opakovaný tisk jednoho balíku.** „Vytisknout znovu“ u balíku 2, s důvodem.                                                                                                                                                                                                        | Vytiskne se **jen** štítek balíku 2. Ostatní úlohy se nezmění a u PPL nic nového nevznikne. Druhý štítek balíku 2 znehodnoťte.                                                                        |          |
| 6   | **Odpojení a restart bez duplicit.** a) Odpojte USB, spusťte opakovaný tisk balíku 3, po minutě USB zapojte. b) Během tisku dalšího opakovaného tisku vypněte Pi (`sudo poweroff` nebo odpojení napájení) a znovu ho zapněte.                                                       | a) Úloha čeká nebo je „Neodesláno“ a po zapojení se nic nevytiskne samo navíc. b) Po startu agent hlásí výsledek úlohy, a pokud mohla vyjít, je „Nejisté“. **Nic se nevytiskne dvakrát automaticky.** |          |

**Závěr:**

- Zapište rozměr etiket, nastavení tmavosti a rychlosti a případné úpravy na tiskárně
  (ne v ZPL – štítky PPL se nemění).
- Nesrovnalost 1/1 místo 3/3 u přeformátované sady se tu neřeší a neobchází. Pokud ji bod 4
  ukáže, adaptér takové ZPL netiskne a čeká se na odpověď PPL.

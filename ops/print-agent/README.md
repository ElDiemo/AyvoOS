# AYVO tiskový agent (Raspberry Pi → Zebra ZD220 DT)

Doc 030, ADR 0028. Agent si přes HTTPS (tailnet) vyzvedává **jen své** tiskové úlohy z AYVO OS a
posílá uložené ZPL přímo do jedné USB tiskárny Zebra ZD220 DT (203 dpi). Jen standardní knihovna
Pythonu 3 (≥ 3.10), žádné další balíčky.

> **Stav (2026-10-20):** software a automatické testy hotové (falešné API a falešné zařízení).
> **Fyzicky neověřeno** – Raspberry Pi ani tiskárna nebyly k dispozici. Velikost etiket, tmavost a
> rychlost tisku se ověří až na skutečných etiketách; agent štítky nikdy nezmenšuje ani neořezává.

## Co agent dělá a co nedělá

- Vlastní identita: token tiskového agenta (vytvoří ADMIN v **Správa systému → Provozovny → detail →
  Tiskárny**; zobrazí se jen jednou). Žádné přístupy PPL, žádný uživatelský účet AYVO.
- Tailscale je jen síť – autentizaci dělá token (hlavička `X-Ayvo-Print-Agent`).
- Žádný otevřený port, žádné příkazy z webu, žádné stahování z cizích adres: všechny URL skládá
  z nakonfigurované základní adresy, přesměrování odmítá.
- Tiskárnu najde podle **sériového čísla USB** (`/sys/class/usbmisc/lp*/device/../serial`) a píše
  jen bajty své úlohy (ověří velikost a SHA-256).
- Před zápisem musí server úlohu **spustit** (u zrušené přepravy to odmítne → nic se netiskne).
- Lokální deník (`/var/lib/ayvo-print-agent`, fsync po každém kroku) přežije restart:
  převzato, ale nezapsáno → „neodesláno“; zápis začal → „nejisté“. **Nic se nevytiskne znovu samo.**
- „Odesláno do tiskárny“ neznamená vytištěno ani nalepeno – to potvrzuje obsluha v AYVO OS.

## Instalace (Raspberry Pi OS)

1. V AYVO OS: Provozovna → Tiskárny → **Přidat agenta** (kód např. `RPI-EXPEDICE`). Token si hned
   zkopírujte – znovu se neukáže (při ztrátě „Vydat nový token“).
2. Zjistěte sériové číslo tiskárny: `cat /sys/class/usbmisc/lp*/device/../serial` (tiskárna připojená
   přes USB). V AYVO OS **Přidat tiskárnu**: model Zebra ZD220 DT, agent, sériové číslo USB, výchozí
   pro expedici, automatický tisk.
3. Na Raspberry Pi (jako root):
   ```sh
   useradd --system --no-create-home --groups lp ayvo-print
   install -d -m 755 /opt/ayvo-print-agent
   cp -r ayvo_print_agent /opt/ayvo-print-agent/
   install -d -m 750 -o root -g ayvo-print /etc/ayvo-print-agent
   install -m 640 -o root -g ayvo-print config.example.json /etc/ayvo-print-agent/config.json
   # token a (jen DEV) heslo Basic Auth: soubory s právy 600, vlastník ayvo-print
   install -m 600 -o ayvo-print /dev/null /etc/ayvo-print-agent/token
   ```
   Token vložte do `/etc/ayvo-print-agent/token` editorem (ne přes příkazovou řádku – zůstal by v historii).
   Upravte `config.json` (`api_base`, u DEV i `basic_auth_user` a soubor s heslem).
4. `cp systemd/ayvo-print-agent.service /etc/systemd/system/ && systemctl enable --now ayvo-print-agent`
5. Kontrola: `journalctl -u ayvo-print-agent -f`; v AYVO OS u agenta „Ozval se“ a u tiskárny
   „Připravena“. Jedno kolo ručně: `python3 -m ayvo_print_agent --once`.

## Fyzické převzetí (zatím NEPROVEDENO)

Na skutečné Zebře ZD220 DT a skutečných etiketách ověřit:

1. tisk štítku PPL (ZPL 203 dpi) bez zmenšení a ořezu, čitelnost čárového kódu;
2. odpojení USB během čekání (úloha zůstane ve frontě) a během tisku (výsledek „nejisté“);
3. restart Raspberry Pi s rozpracovanou úlohou (žádný tisk navíc);
4. storno přepravy s čekající úlohou (netiskne se).

## Testy

`pnpm test` (v tomto adresáři; spouští i `pnpm test` v kořeni repozitáře) – falešné API AYVO OS a
falešné zařízení, žádný hardware.

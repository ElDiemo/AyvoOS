# AYVO tiskový agent: Raspberry Pi → USB → Zebra ZD220 DT

Doc 030, ADR 0028. Agent si přes HTTPS v tailnetu vyzvedává **jen své** tiskové úlohy z AYVO OS
a posílá uložené ZPL přímo do jedné USB tiskárny Zebra ZD220 DT (203 dpi). Používá jen Python 3
(≥ 3.9, testováno na 3.12), bez dalších balíčků.

> **Stav (2026-10-20):** software je hotový a testovaný proti falešnému API a falešnému zařízení.
> **Na skutečném Raspberry Pi ani Zebře neověřeno.** Agent funguje až proti AYVO OS s PR #38
> (dnes není na DEV nasazený). Fyzické převzetí: [ACCEPTANCE.md](ACCEPTANCE.md).

## Zásady

- **Existující Raspberry Pi OS:** nic se nepřeinstalovává, karta se nemaže. Neinstalují se
  balíčky a nemění se síť, Tailscale ani CUPS.
- **Agent neběží jako root:** běží jako systémový uživatel `ayvo-print` (skupina `lp` pro
  `/dev/usb/lp*`) a po restartu se obnoví (systemd, `Restart=always`).
- **Tajemství:** token agenta a heslo DEV Basic Auth se zadávají bez opisu na obrazovku. Ukládají
  se jen do souborů s právy 600 v `/etc/ayvo-print-agent`. Nikdy nejsou v Gitu, v argumentech
  příkazů, v historii shellu ani v logu.
- **Tailscale je jen síť:** autentizaci dělá token agenta.
- **Agent je opatrný:**
  - nemá otevřený port a nesleduje přesměrování;
  - tiskne jen bajty své úlohy (ověří velikost, SHA-256 a začátek `^XA`);
  - před zápisem si úlohu nechá potvrdit serverem;
  - podle deníku po restartu nic sám nevytiskne znovu.

## Postup (na Raspberry Pi, jako běžný uživatel se sudo)

**0. Zkopírujte složku** `ops/print-agent` z repozitáře na Pi, např. `scp -r ops/print-agent pi@<pi>:~/`.

**1. Zjištění stavu (jen čtení):**

```sh
cd ~/print-agent
bash preflight.sh https://dev.ayvo.co/api
```

Skript vypíše:

- systém, model, architekturu a synchronizaci času;
- verzi Pythonu;
- Tailscale, překlad `dev.ayvo.co` (musí být adresa `100.x`) a dostupnost serveru (na DEV
  očekávaně `401`, protože se vyžaduje Basic Auth);
- Zebru na USB (výrobce `0a5f`), zařízení `/dev/usb/lpN` a jeho **sériové číslo USB**;
- případnou starší instalaci agenta.

Pokračujte, až skončí `PREFLIGHT OK`. Sériové číslo si poznamenejte.

**2. V AYVO OS (ADMIN):** Správa systému → Provozovny → provozovna → **Tiskárny**:

1. **Přidat agenta** (např. kód `RPI-EXPEDICE`). Token se zobrazí **jen jednou**; nechte okno
   otevřené až do kroku 3.
2. Tiskárnu přidáte až v kroku 4 – agent ji po instalaci sám nahlásí.

**3. Instalace (opakovatelná, při dalším spuštění jen aktualizuje):**

```sh
sudo bash install.sh --api-base https://dev.ayvo.co/api --basic-auth-user <DEV uživatel>
```

Skript se zeptá na token agenta a na heslo DEV Basic Auth; nic se nezobrazí. Pak:

- vytvoří uživatele `ayvo-print`;
- nahraje kód do `/opt/ayvo-print-agent`;
- zapíše konfiguraci do `/etc/ayvo-print-agent`;
- nainstaluje a spustí službu `ayvo-print-agent`.

Při dalším spuštění nastavení i tajemství zůstanou. Novou hodnotu zadáte přepínačem
`--set-token` nebo `--set-basic-auth-password`.

**4. Kontrola:**

- `systemctl status ayvo-print-agent`;
- `journalctl -u ayvo-print-agent -f` (token se v logu nikdy neobjeví);
- v AYVO OS **Obnovit stav**: u agenta „Ozval se“;
- **Přidat tiskárnu:** vyberte toto Raspberry Pi, potom nahlášenou Zebru (porovnejte sériové
  číslo s krokem 1), „Výchozí tiskárna pro expedici“, **automatický tisk zatím vypněte** (zapne
  se až po akceptaci), uložte. Nic se nevybere samo; když agent nic nehlásí, zkontrolujte USB a
  stav obnovte (ruční zadání čísla je pod „Pokročilé“);
- u tiskárny „Připravena“.

**5. Restart:** `sudo reboot`. Po startu musí agent znovu hlásit „Ozval se“, bez zásahu.

## Údržba

- **Ztracený nebo prozrazený token:** v AYVO OS „Vydat nový token“, pak `sudo bash install.sh --set-token`.
- **Vyřazení Pi:** v AYVO OS „Zrušit agenta“ (token přestane platit) a `sudo systemctl disable --now ayvo-print-agent`.
- **Deník úloh:** `/var/lib/ayvo-print-agent`. Nemazat, dokud agent nenahlásil všechny výsledky.

## Testy

`pnpm test` v tomto adresáři (spouští ho i `pnpm test` v kořeni repozitáře). Používá falešné
API AYVO OS a falešné zařízení, žádný hardware. Skripty kontroluje `shellcheck`.

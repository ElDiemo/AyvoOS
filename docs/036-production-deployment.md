# 036 — Production deployment (AyvoOS-PROD, https://os.ayvo.co)

Status: **prepared, not installed** (owner request 2026-10-22, clarified 2026-10-23). Nothing in
this document has been run on AyvoOS-PROD. ADR 0033 records the decision.

Production runs **the same application code as DEV** — one approved release commit at a time —
with its own configuration, secrets, database, Redis, volumes and images. There is no
production-only mode, no feature switch and no different navigation: a salesperson sees only
Obchod because of the normal `SALES` role (doc 021, doc 034). Production starts only when every
start condition of the whole application is really met (§8); none is bypassed with a placeholder.

## 1. Pieces

| Piece                                                                             | Where                                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Compose project `ayvo-prod` (caddy, dns, web, api, migrate, postgres, redis)      | `deploy/prod/compose.yml`                       |
| Edge: Caddy (tailnet only, ACME on public IPv4 :80), private DNS for `os.ayvo.co` | `deploy/prod/Caddyfile`, `deploy/prod/Corefile` |
| Host guard for published Docker ports (IPv4 + IPv6), sysctl, install / uninstall  | `deploy/prod/host/`                             |
| Deploy script (check, deploy, rollback, first administrator)                      | `scripts/deploy-prod.sh`                        |
| Server-only env files (names)                                                     | `deploy/prod/prod.env.example`                  |
| Database backups and restore check                                                | `ops/prod-backup`, doc 035 (separate PR)        |
| Application files in private S3                                                   | ADR 0032 (#47)                                  |

## 2. Server (AyvoOS-PROD)

Ubuntu 24.04, ~4 GB RAM, ~70 GiB free. Public IPv4 `2.29.17.36`, Tailscale IPv4 `100.88.139.2`.
UFW active, SSH with keys; **public SSH stays** as the fallback (nothing here touches it).

- Docker Engine 29.9.0 + Compose 5.6.0 from Docker's apt repository (installed 2026-10-23).
  `ayvo` is not in the `docker` group (root-equivalent): the owner decides (§6 step 2).
- **Swap**: the web image build needs about 3 GB; with 4 GB RAM and no swap the kernel's OOM
  killer stops it (seen on DEV). A 4 GiB swap (`/swap-ayvo-prod`) exists since 2026-10-23; the
  deploy script refuses to build with less than 3 GB of RAM + swap available.
- Docker's own logs are rotated per container by `compose.yml` (5 × 10 MB). Releases keep the
  images of the three newest releases; older `ayvo-prod/*` images are removed by name. No
  `prune`, no volume removal, ever. The deploy script needs ≥ 8 GB free before a build.
- The repository on the server: a read-only checkout (e.g. a GitHub deploy key) in
  `/opt/ayvo/repos/AyvoOS`, used only to `git archive` an approved commit.

## 3. Network: tailnet only, no Basic Auth

- HTTPS (443 TCP/UDP) and the private DNS (53) are published **only on the Tailscale IPv4**
  read from `tailscale ip -4` on every run (never configurable, never `0.0.0.0`, never IPv6).
  Public IPv4 :80 is one exception: Caddy answers its own ACME HTTP-01 challenges there and
  aborts every other request — the application is never served on it. The other is the separate
  **public QR edge** on the public IPv4 :443, which serves only `GET /<token>` → the passport
  (doc 037, ADR 0035); `os.ayvo.co` is never served there.
- PostgreSQL, Redis, the API and the web server publish **no port**; postgres and redis are on an
  internal network without egress.
- Caddy admits only peers from `100.64.0.0/10` by the real TCP peer address. The Docker gateway is
  never admitted as a stand-in: Tailscale's SNAT must be off instead.
- Sign-in is the normal application sign-in (WorkOS, MFA); no Basic Auth (as ADR 0030 for DEV).
- **UFW does not filter Docker's published ports.** `deploy/prod/host/ayvo-prod-docker-guard`
  puts a chain first in `DOCKER-USER` for IPv4 **and** IPv6: new connections entering through the
  public interface towards a container are dropped, except IPv4 TCP :80 and TCP :443 of the
  public address (the QR edge; new connections limited per source). Tested with recorded
  `iptables`/`ip6tables` calls (`apps/api/test/deploy-prod.test.ts`).
- **Right host first.** `install.sh`, `uninstall.sh` and `scripts/deploy-prod.sh` start with
  `deploy/prod/host/prod-host.sh`: hostname `AyvoOS-PROD`, Tailscale IPv4 `100.88.139.2`, and no
  trace of the DEV preview (its env file, guard, sysctl or containers; if the containers cannot
  be listed, it refuses too). Anything else is refused before the first change. A renamed or
  re-addressed server needs a reviewed change of that file.
- `sudo bash deploy/prod/host/install.sh --check` verifies without changing anything: Docker,
  Tailscale address, the public default route, **no subnet routes shared by this node**, no Docker
  network inside `100.64.0.0/10`. Then `sudo bash deploy/prod/host/install.sh` backs up iptables,
  ip6tables, the sysctl and the Tailscale prefs to `/var/backups/ayvo-prod-host/<time>`, installs
  the guard (enabled, re-applied on every Docker start), `ip_nonlocal_bind=1`, and turns SNAT off
  (`tailscale set --snat-subnet-routes=false`; NoSNAT is false today).
- Rollback: stop `caddy` and `dns`, then `sudo bash deploy/prod/host/uninstall.sh` (guard,
  sysctl and SNAT back); `iptables-restore` / `ip6tables-restore` of a backup restores an exact
  earlier state.
- Tailscale split DNS for `os.ayvo.co` → `100.88.139.2` (the private DNS answers only that name
  and refuses everything else; it is never a resolver) — set in the Tailscale admin console.

## 4. Secrets and configuration

Server-only files in `/opt/ayvo/secrets`, owner `ayvo`, mode 600. The deploy script checks
existence, mode, owner and **key names** (never prints a value) and refuses forbidden keys
(`APP_ENV`, `AUTH_PROVIDER`, `CARRIER_PROVIDER`, `PPL_TEST_*`, `FILE_STORAGE_*`, `DEV_*`):

| File                                                  | Keys                                                                                                                                                                                         | Used by               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `prod.env` (new, from `deploy/prod/prod.env.example`) | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `ACME_EMAIL`, `PUBLIC_QR_BASE_URL` (optional: `LABEL_QR_MIN_SIZE_MM` + `LABEL_QR_ERROR_CORRECTION` together, `CARRIER_CREDENTIALS_KEY`) | Compose interpolation |
| `prod-workos.env` (exists)                            | `WORKOS_API_KEY`                                                                                                                                                                             | api (`env_file`)      |
| `prod-s3.env` (exists)                                | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — the application identity                                                                                                                      | api (`env_file`)      |
| `prod-s3-backup.env` (exists)                         | the backup identity (doc 035) — refused if it equals the application's                                                                                                                       | backups only          |
| `prod-workos-client.env` (exists)                     | not read by this release (`--check` lists its key names)                                                                                                                                     | —                     |

If an existing file uses other key names, rename them on the server; values are never copied
anywhere else. Fixed, non-secret values are in `compose.yml`: `APP_ENV=production` (api and web),
`APP_PUBLIC_ORIGIN=https://os.ayvo.co`, WorkOS client `client_01M4R7SYY9BSQQCT0RHV4E468Q` and its
issuer `https://api.workos.com/user_management/client_01M4R7SYY9BSQQCT0RHV4E468Q`,
`FILE_STORAGE_DRIVER=s3`, `eu-north-1`, bucket `ayvo-prod-files-888725257303-eu-north-1-an`,
owner `888725257303`.

WorkOS Production (dashboard, owner): redirect `https://os.ayvo.co/api/auth/callback`, initiate
login `https://os.ayvo.co/api/auth/login`, sign-out `https://os.ayvo.co/login?signed_out=1`,
public sign-up off, MFA required (confirmed by the owner); the first real sign-in is still to be
verified (§9).

**Never** `docker compose config` without `--quiet` on this server: it prints the env files.

## 5. Verification after a deployment

The script verifies through the tailnet address: API health (`production`, database up, Redis
up), `/login` 200, `/` → sign-in, `/api/auth/me` and the administration 401 without a session,
the published ports exactly as in §3, and — **as a local hint only** — that the public IPv4 serves
only the QR passport (doc 037: unknown token, other paths, `os.ayvo.co`) and aborts :80.

A test from the server itself is no proof for the internet. After the first installation and after
every change of the edge or the host guard, the owner tests **from a machine outside the tailnet**:

```bash
curl -m 10 -v https://os.ayvo.co/                    # name not resolvable publicly, or no connection
curl -m 10 -v --resolve os.ayvo.co:443:2.29.17.36 https://os.ayvo.co/   # TLS failure (only the QR edge listens), never the app
curl -m 10 -v http://2.29.17.36/                     # empty reply (aborted), never the app
nc -vz -w 5 2.29.17.36 5432; nc -vz -w 5 2.29.17.36 6379; nc -vz -w 5 2.29.17.36 4000; nc -vz -w 5 2.29.17.36 3000
# and the same for the server's public IPv6 address, if it has one (:80 and :443 must not connect)
```

and the public QR checks of doc 037 §5.

## 6. First installation (owner, in this order)

Every step is the owner's, on AyvoOS-PROD (SSH as an administrator, then `ayvo`). Nothing is copied
from DEV. A step that fails stops the installation; nothing is skipped or replaced by a placeholder.

1. **Read-only state check** (changes nothing): `hostname; free -h; swapon --show; df -h /;
tailscale ip -4; docker --version; docker compose version; ls -l /opt/ayvo/secrets;
systemctl status ayvo-prod-docker-guard; ls /opt/ayvo/repos/AyvoOS`.
2. **Docker Engine + Compose plugin — already prepared (2026-10-23, record
   `/home/ayvo/PROD-RUNTIME-PREPARED-20261023.md`):** Docker 29.9.0, Compose 5.6.0, `jq`. Only
   verify (`docker --version; docker compose version; systemctl is-enabled docker`); never install
   again. **Owner decision 2026-10-23: `ayvo` stays out of the `docker` group; the deploy script
   runs with `sudo`.** It still accepts only env files owned by `ayvo` (or root) with mode 600,
   and runs every `git` command as `ayvo` (`runuser`): that user's checkout, read-only deploy key
   and `known_hosts` — never as root, never `safe.directory`, never relaxed host key checking.
3. **4 GiB swap — already prepared** (`/swap-ayvo-prod`, one `/etc/fstab` entry). Only verify:
   `swapon --show` shows 4G. **Never create a second swap file.**
4. **Read-only release access:** as `ayvo`, `ssh-keygen -t ed25519 -f ~/.ssh/ayvoos_deploy -N ''`;
   the public key becomes a **read-only deploy key** of the repository (GitHub → Settings → Deploy
   keys, "Allow write access" off); then `git clone -c core.sshCommand='ssh -i
~/.ssh/ayvoos_deploy -o IdentitiesOnly=yes' git@github.com:ElDiemo/AyvoOS.git
/opt/ayvo/repos/AyvoOS`. It is only fetched and `git archive`d — never edited, never pushed.
   GitHub's host key goes into `ayvo`'s `~/.ssh/known_hosts` only after comparing it with the
   published fingerprint (ED25519 `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`,
   docs.github.com → "GitHub's SSH key fingerprints"); host key checking stays on. The checkout,
   the key (600) and `known_hosts` belong to `ayvo`; `--check` refuses a checkout of another
   owner.
5. **Host guard and the edges' separation:** `sudo bash deploy/prod/host/install.sh --check`,
   then without `--check` (§3). Tailscale split DNS `os.ayvo.co` → `100.88.139.2` (internal);
   the public DNS A record of the QR host → the public IPv4, no AAAA (doc 037, when that edge is
   part of the release).
6. **`/opt/ayvo/secrets/prod.env`** from `deploy/prod/prod.env.example`, mode 600, values set on
   the server only (new `POSTGRES_PASSWORD`, `ACME_EMAIL`, `PUBLIC_QR_BASE_URL` = the production QR
   host). **No QR label settings** until the recorded physical validation (§8, ADR 0034); no DEV
   value of any kind. Check the existing files' key names (§4).
7. **The release:** one commit `C` on `origin/main` that contains this deployment and everything
   the owner approved for production (#47 S3, #48, #50 backups, #53 QR settings, the public QR edge
   if wanted). **`C` is first deployed and verified on DEV** (`scripts/deploy-dev.sh` from a
   checkout of exactly `C`, owner approval as always); only the same `C` is then promoted here.
8. `sudo scripts/deploy-prod.sh --check --release <C>` — must pass (host, guard, files, release, WorkOS
   issuer, DNS, Compose).
9. `sudo scripts/deploy-prod.sh --release <C>`: the database is **new and empty**; it is created only
   by `prisma migrate deploy` from the migrations — never a copy of DEV, never test seeds or
   demo records. The script backs up nothing on an empty database (it says so), migrates, starts,
   verifies.
10. The external negative test (§5, and doc 037 §5 for the QR host).
11. **First administrator, once:** `sudo scripts/deploy-prod.sh --bootstrap-admin --email <owner's
e-mail, verified in WorkOS> --name "<name>"` — the existing one-time mechanism (doc 021 §8);
    the database allows one bootstrap ever. **The first real sign-in with WorkOS + MFA is the
    owner's own step** — no automated test borrows or creates a session for it.
12. **Salesperson:** by a normal AYVO invitation (Správa systému → Uživatelé, role `SALES`); the
    person accepts it and signs in with WorkOS + MFA.
13. **Backups before any timer** (doc 035 §6): install the tool; one real backup to S3; download it
    back and verify the checksum; the isolated restore check (`--network none`) must report OK;
    **only then** enable the timers. Until that, production holds no data worth more than a fresh
    installation.

## 7. Later releases, failure and rollback

- `--release <commit>`: export → build (one image at a time, the old release still serving) →
  **api and web stopped** (nothing is written after the dump, the old code never runs on the new
  schema; the application is unavailable until the new release has started) → postgres/redis up → **dump of the
  current database** (`/opt/ayvo/prod/backups/predeploy-…dump`, checked with `pg_restore --list`)
  and, with the backup tool installed, a verified S3 backup → `migrate deploy` → api/web, then
  caddy/dns → verify → record (`/opt/ayvo/prod/state`). Log: `/opt/ayvo/prod/deploy.log`.
- The S3 backup of that step runs as the approved owner in the context of the scheduled one
  (`runuser`: user and group `ayvo`, the `docker` group for that process only, umask 077, systemd's
  default PATH) — never as root: the credentials stay `ayvo:600` and the timer keeps owning
  `/var/lib/ayvo-backup`. An entry there that `ayvo` does not own stops the deployment before the
  backup (inspect it and restore its owner; never delete results blindly). A busy timer (exit 75)
  is waited for, then our own fresh backup is taken; without it nothing is migrated.
- Any failure stops at that step and reports it, the dump, whether migrations ran and the previous
  release. Nothing is undone silently, and **a database is never restored automatically** — an
  older backup is never written over newer data without the owner deciding (doc 035 §4).
- `--rollback <12-character release>` starts the images of an earlier release again without
  building or migrating. Safe only when that code works with the current schema (migrations are
  additive by policy; check the release notes). Otherwise: fix forward, or a deliberate restore.

## 8. Start conditions of the whole application (none bypassed)

The API refuses to start in production unless all of these are real:

1. `APP_PUBLIC_ORIGIN` = `https://os.ayvo.co` — fixed in `compose.yml`.
2. WorkOS: API key (file), client ID and issuer — set; the real sign-in still to be tried.
3. File storage: `FILE_STORAGE_DRIVER=s3` with the application identity — needs **#47 merged**.
4. `PUBLIC_QR_BASE_URL`: in production only the production QR host `https://qr.ayvo.co` is
   accepted (ADR 0014). The owner sets it in `prod.env`.
5. `LABEL_QR_MIN_SIZE_MM` and `LABEL_QR_ERROR_CORRECTION` are **not** a start condition
   (ADR 0034): they come only from the recorded physical print/scan validation (doc 016
   production blockers, ADR 0014) and have no default. Until the owner sets both, production runs
   (sign-in, Obchod, passports, history, carrier labels) and refuses only the creation and
   printing of our QR labels (`QR_LABEL_SETTINGS_MISSING`). `--check` refuses only one of the
   two.
6. No `AUTH_PROVIDER=test`, no `CARRIER_PROVIDER=test`, no PPL TEST credentials (refused).

## 9. Risks and open items

- The AWS spend limit (20 USD/month) can suspend the project: then file storage and backups fail
  (doc 035 §8). Billing is the owner's.
- Building on a 4 GB server is slow and memory-bound (§2). Building elsewhere and transferring
  images (e.g. a registry) would be an infrastructure decision of the owner — not prepared.
- The first real WorkOS sign-in on `os.ayvo.co`, the external negative test and the restore check
  have not been done (nothing is installed).

## 10. The Finance unit (ADR 0039, docs 039–041)

The same topology as on DEV, approved there: its own container from the **same** api image the OS
release built (never built again), its own DB roles and schema `finance`, its own S3 identity, the
core reached only through `/api/internal/v1/finance/*` (service token + forwarded session), which
the edge aborts. Finance is installed and replaced only by `scripts/deploy-prod.sh --finance`; the
OS deployment never starts, stops or rebuilds it. The bank connection (doc 041) is optional, §10a.

**Prerequisites (owner, on AyvoOS-PROD):**

1. The OS runs a release that contains this section (Caddy route + `/api/internal/*` abort, web
   `FINANCE_API_URL`, API `FINANCE_SERVICE_TOKEN_SHA256`).
2. `prod.env`: the four `FINANCE_*` keys (generated on the server, `prod.env.example`), then the OS
   release deployed again so the API holds the token's SHA-256 (checked by `--finance`).
3. `prod-finance-s3.env` (mode 600): an IAM identity of its own with the application's rules
   (ADR 0032) narrowed to Finance's prefixes: the read-only bucket configuration permissions
   checked at start (`s3:ListBucket` for HeadBucket, `s3:GetBucketVersioning`,
   `s3:GetBucketPublicAccessBlock`, `s3:GetBucketOwnershipControls`, `s3:GetEncryptionConfiguration`),
   and `s3:GetObject` / `s3:PutObject` on `finance-documents/*` and `accounting-exports/*` only —
   no DeleteObject, no ACL or configuration change, no other prefix, no backup bucket. Writes are
   create-only (`If-None-Match: *`). The script refuses the application's or the backup identity.

The first OS release with this section adds the network `finance-db` to PostgreSQL: Compose
recreates the `postgres` container during that OS deployment (a short restart inside the deploy;
the data volume is unchanged).

**Install / replace:** `sudo scripts/deploy-prod.sh --finance --release <the commit the OS runs>`:
the OS deployment records the image IDs each release was built as (`state/images/<release>`);
before any change Finance is pinned to them — the running API must be exactly that api image, and
Finance and its migrations run those IDs, never a tag a later build may have moved (PROD78-R1) →
pre-migration dump (and S3 upload when the backup tool is installed) → roles + schema as the
privileged account → migrations as `ayvo_finance_owner` → only the `finance` container
(`mem_limit 512m`, `cpus 0.5`, `pids_limit 128`, read-only) → verify: ready (database + core
contract), `/api/admin/finance/*` 401 without a session, `/api/internal/*` aborted → recorded in
`state/finance.log`.

**What stops during `--finance`:** only the Finance unit — on an upgrade its old container is
stopped before the dump (nothing it writes may follow the backup, its old code must not run on the
new schema); on the first installation nothing is stopped. The OS (api, web) keeps serving the
whole time: Finance's migrations change schema `finance` only, `pg_dump` is a consistent snapshot,
and Finance itself needs the running API to become ready. The dump and its S3 copy are labelled
`finance-<release>`. If a step fails, the OS is untouched; Finance is stopped (upgrade) or absent
(first installation) — `--finance-rollback <previous>` starts the previous Finance again, nothing
is recorded in `state/finance.log` until Finance is verified.

**Incident 2026-10-26 (first PROD installation):** the first version of `--finance` reused the OS
backup step, which stops api and web; they were not started again, so Finance's verification got
503 and the public ID card 502 until the operator started the existing api and web containers
(no code or configuration change; `finance.log` correctly not written). Fixed as above and covered
by a test of the real `finance` case flow (first installation, upgrade, failed migration).

**Rollback:** `--finance-rollback <earlier release>` starts the image ID recorded for it in
`state/finance.log` again (no migration; safe only if it works with the current schema). Image
cleanup after an OS release keeps, besides the OS keep-set, the running and the previous verified
Finance release (images and exports) on Finance's own history (PROD78-R2). To take Finance out entirely:
`docker compose -p ayvo-prod stop finance` — the OS keeps running, Finance pages say "Finance jsou
dočasně nedostupné". Finance data stay (schema `finance` in the same database and its dumps).

**Backups:** the database dumps (doc 035) include schema `finance`; its files are in the
production bucket under the prefixes above (versioned bucket, ADR 0032).

### 10a. Optional: bank transactions from RB Premium API (doc 041)

Off unless the owner switches it on; off, Finance runs exactly as without this section (the page
says "Banka zatím není připojena", nothing is mounted, no variable is set). Reading only — the
application has no payment, batch or statement call.

**Switch on (owner, then `--finance`):**

1. The owner stores three files in `/opt/ayvo/secrets/rb-premium/` (procedure without showing any
   value: the owner's RB configuration handoff, §3): `client-id`, `certificate.p12`,
   `p12-passphrase`. Directory `0500`, files `0400`, all owned by uid 1000 (the Finance process);
   nothing else in the directory. These production files never on DEV, never in Git, an env file, a log or a chat.
2. `prod.env`: `RB_PREMIUM_ACCOUNTS=<number>:CZK` — which accounts are read (not a secret).
3. `sudo scripts/deploy-prod.sh --finance --release <the commit the OS runs>`.

**What the script does:** the preflight checks the accounts' format and the files' kind, owner,
mode and that exactly those three exist — never their contents. `compose.rb-premium.yml` is then
added for Finance alone: `RB_PREMIUM_ENVIRONMENT=production`, the three file paths, the accounts,
and the directory mounted **read-only** at `/run/secrets/rb-premium`. The verification checks
inside the Finance container that it has the production connection, that its process can read
the three files and cannot write there; it sends **no request to the bank**. Without
`RB_PREMIUM_ACCOUNTS` it checks that Finance has no bank connection and no mount. Network:
outgoing HTTPS to the bank's fixed host only (host guard / firewall, Codex).

**First live read:** only with the owner, on their explicit instruction, by "Načíst nové pohyby"
in Finance → Bankovní pohyby (89 days back), compared with the internet banking. Transactions are
never paired with anything until issued invoices exist.

**Switch off:** remove `RB_PREMIUM_ACCOUNTS` from `prod.env` and run `--finance` again with the
release the OS runs: Finance is recreated without the variables and the mount; read transactions
and sync runs stay, the files stay where they are (removed only on the owner's instruction).

**The same path on DEV, with the bank simulation (no bank, no production material):** the
configuration, the file mount and the procedure above are rehearsed on DEV before production —
only the counterpart differs. Nothing of this path exists on PROD alone.

1. `scripts/dev-rb-simulation-certs.sh` (on DEV, as uid 1000) creates test certificates that have
   nothing to do with the bank: a throw-away CA (its key discarded), the server certificate of
   `rb-simulation`, a client certificate with a random passphrase and a random client ID — in
   `/opt/ayvo/secrets/rb-premium/` (the same three files **plus** `simulation-ca.crt`) and
   `/opt/ayvo/secrets/rb-simulation/` (the simulation's own). It refuses a host with `prod.env`
   and never replaces an existing set.
2. `dev-preview.env`: `RB_PREMIUM_ACCOUNTS=<synthetic number>:CZK`.
3. `scripts/deploy-finance-dev.sh` — the same file checks as production
   (`scripts/lib/rb-premium-files.sh`: kind, owner uid 1000, `0500` / `0400`, exactly these files),
   `deploy/dev/compose.rb-premium.yml` added: the same read-only mount and variables for Finance with
   `RB_PREMIUM_ENVIRONMENT=simulation` and `RB_PREMIUM_SIMULATION_CA_FILE`, and the `rb-simulation`
   container (same image, its own entry point, read-only, no published port) on an internal network
   shared with Finance alone. The verification runs the same in-container check as production and
   one mTLS read of the simulation.

`simulation` is refused with APP_ENV=production; its URL (`https://rb-simulation:8443/…`) is fixed
in code; the simulation's CA is required with it and refused with the bank, so production trusts
only the system CAs. TLS is verified in full (certificate chain and the name `rb-simulation`); a
foreign CA or client certificate is refused (tests: `apps/api/test/dev-rb-simulation.e2e.test.ts`).
The simulation answers synthetic incoming payments only; read transactions are stored as `TEST`.

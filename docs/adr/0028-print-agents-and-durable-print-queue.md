# ADR 0028: Print agents with their own identity and a durable print queue

- **Status:** Proposed — requested by the owner 2026-10-20 (PR C, doc 030); needs the owner's review
- **Date:** 2026-10-20
- **Deciders:** AYVO owner; AYVO OS lead architect
- **Supersedes / Superseded by:** extends ADR 0022 (identity) with a second, non-human principal;
  extends doc 029 (dispatch) with direct printing.

## Context

Dispatch labels (doc 029) must reach a Zebra ZD220 DT (native ZPL, 203 dpi) attached by USB to a
Raspberry Pi at the site. The owner wants the operator's one action "Dokončit a vytisknout štítky"
to end with the labels on that printer. Constraints: no public print ports, no commands or URLs
from the web to the device, Tailscale is transport only and never replaces authentication, the
device needs neither PPL credentials nor AYVO administration rights, PostgreSQL stays the source
of truth for the queue and its history, and the result of a USB write cannot be confirmed by the
hardware — "printed exactly once" must never be claimed.

ADR 0022 says identity comes only from the `ayvo_session` cookie: that rule is about **people**.
A print agent is a machine without a browser session, so it needs its own, narrower principal.

## Decision

1. **Print agents are their own principal** (`print_agents`): a code, a name, one site, and a
   token whose **SHA-256 hash only** is stored. The token (`ayvo_pa_<code>_<43 chars>`, 256 random
   bits) is shown once when an ADMIN creates or rotates it (`printing:manage`, security
   administration — never a custom role) and can be revoked. Agent routes live under
   `/api/agent/v1/*` and declare `@PrintAgentAccess()`; the global guard reads the token from the
   `X-Ayvo-Print-Agent` header **only** on those routes (never a user identity, never a cookie) and
   refuses it everywhere else. An agent sees only the jobs of printers assigned to it, and only the
   stored ZPL of a job it holds. It has no user permissions at all.
2. **Durable queue in PostgreSQL** (`print_jobs` + append-only `print_job_events`): one job per
   parcel label, bound to order, shipment, parcel, the stored label variant and the printer —
   fixed at creation (changing the site's default printer never redirects an existing job).
   States: `QUEUED → CLAIMED → SENDING → SENT | FAILED | UNCERTAIN`, `QUEUED/CLAIMED →
CANCELLED`. Claiming is one conditional update (`FOR UPDATE SKIP LOCKED`) with a claim token
   and a lease. The agent must call **start** (server-confirmed, refused if the job became
   invalid — e.g. its shipment is being cancelled) **before** it writes to the device. A claim
   that never started returns to `QUEUED` when its lease ends (nothing was written); a started job
   without a result becomes `UNCERTAIN` and is **never** retried automatically.
3. **What "SENT" means:** the agent wrote every byte to the USB device without an error. It is
   not proof of a printed or applied label; only the operator's confirmation "Připraveno k
   vyzvednutí" is (doc 029).
4. **Re-printing** is an explicit, permitted (`printing:reprint`) and audited new job for one
   parcel, using the same stored label; when an earlier job of that parcel was `SENT` or
   `UNCERTAIN` the request must acknowledge the risk of a physical duplicate.
5. **The agent** (`ops/print-agent`, Python standard library, systemd) polls over HTTPS through the
   tailnet, keeps a local journal (survives restarts), writes only the bytes of its own job to the
   USB device identified by its serial number, and builds every URL itself from its configured
   API base (it never follows a URL from a response). After a restart, a job journaled as claimed
   but never written is reported as failed before sending; one whose write started is reported as
   uncertain.

## Consequences

- A stolen agent token prints only stored labels on its own site's printers and reads nothing
  else; it is revoked in the administration. The DEV edge (Caddy Basic Auth, tailnet only) stays
  unchanged: the agent also sends the DEV Basic Auth credentials.
- Physical acceptance (real printer, real labels, media size) is a separate, explicit step; until
  then printing is "implemented and tested against a simulated agent", never "verified".

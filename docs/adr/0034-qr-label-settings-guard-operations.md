# ADR 0034: Missing QR label settings refuse QR label operations, not the application

- **Status:** Accepted — owner decision 2026-10-23
- **Date:** 2026-10-23
- **Supersedes:** in ADR 0014 the sentence "production refuses to start without both being set
  explicitly" (and the same rule in doc 016 "Production blockers" item 2)
- **Related:** ADR 0014 (public QR identity), ADR 0016 (storage), doc 016, doc 036

## Context

The QR print settings of our labels — minimum size `LABEL_QR_MIN_SIZE_MM` and error correction
`LABEL_QR_ERROR_CORRECTION` — stay provisional until the physical print/scan test (doc 016). Until
now production refused to START without them. That blocks everything that has nothing to do with
our QR labels: sign-in, Obchod, reading bottles and history, and carrier labels (PPL PDF/ZPL).

## Decision

1. Missing settings never stop the application. In production they have **no default**: the
   candidate values (10 mm / Q) apply only outside production, and an empty value (e.g. Compose
   `${VAR:-}`) counts as not set. A malformed value is still a startup error.
2. Without both values only the operations that need them are refused with `409
QR_LABEL_SETTINGS_MISSING` (`apps/api/src/labels/qr-label-settings.ts`): designing a template
   with a QR element, template calibration prints, bottle registration (refused before any
   identity is created), creating, generating, re-generating and downloading bottle and crate
   label print jobs, the crate label preview and workstation QR labels.
3. An existing print job is rendered or handed out only under the current settings: a job made
   with another error correction answers `QR_LABEL_SETTINGS_CHANGED`, a QR below the current
   minimum `QR_LABEL_TOO_SMALL` — create a new job.
4. Not affected: the QR validation sheet (it serves to validate the settings), the public
   passport, bottle and template details (shown without a QR image), print history, carrier
   labels and the print queue. All other production guards stay (authentication, storage, the
   DEV/production QR separation of ADR 0014).

## Consequences

- Production can run Obchod and the rest before the physical QR test; our QR labels become
  available only when the validated values are configured — never through a default.
- Deployment files and preflight checks must not require the two values (doc 036).

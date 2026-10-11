# ADR 0016: File storage abstraction (local volume for DEV, object storage for production)

- **Status:** Accepted for DEV — confirmed by owner 2026-10-10. Production storage is a
  **blocker** (see below).
- **Date:** 2026-10-10
- **Deciders:** AYVO owner; AYVO OS lead architect

## Context

Label artwork uploads and generated print PDFs are binary files of up to several megabytes.
PostgreSQL is the source of truth for metadata (ADR 0002), but large binaries do not belong in
it. Containers must not keep data in their image layers. Production runs on a separate VPS.

## Decision

- Domain modules use a `FileStorage` interface (`put(key, bytes)`, `get(key)`), injected via the
  `FILE_STORAGE` token. They never handle filesystem paths.
- Keys are **server-generated and immutable** (`<namespace>/<yyyy>/<mm>/<uuid>.<ext>`), validated
  against a strict pattern; `put` **never overwrites**. PostgreSQL stores key, size, SHA-256 and
  content type next to the domain record.
- **DEV only:** `LocalFileStorage` on `FILE_STORAGE_DIR` (`FILE_STORAGE_DRIVER=local`), in the named
  Docker volume `ayvo-dev-preview-files-data` at `/var/lib/ayvo/files` (API root filesystem
  read-only). Writes are atomic (temp file + hard link); paths stay inside the root.
- **No silent fallback in production:** with `APP_ENV=production` the API refuses to start while
  `FILE_STORAGE_DRIVER=local` (config validation and the storage provider factory both refuse).
- Files are served only through admin API routes; storage paths never reach clients. A missing
  file returns a stable 404 ("The stored file is not available").
- The interface has **no delete**: stored objects back immutable records (template versions,
  print jobs) and cannot be removed through the application.
- **Write order and recovery:** file first, then the database row/state. A failure in between
  leaves an unreferenced file (logged with its key), never a record without its file. Print jobs
  are marked `COMPLETED` only after their PDF is stored (doc 016, "Print jobs").

## Production requirements (blocking, not implemented)

- An **S3-compatible object-storage** implementation of `FileStorage` (keep the abstraction).
- Immutable, server-generated object keys; **bucket versioning or object lock** (or equivalent
  overwrite protection).
- **Off-site backups** of artwork and every non-regenerable file, defined **retention**, a written
  **restore procedure** — and a **real restore test** before production approval.
- Note: print PDFs can be regenerated from immutable versions + bottles; artwork cannot.

**A PostgreSQL dump is not a backup of the files.** The DEV deploy script backs up PostgreSQL
only; the files volume is not backed up.

## Consequences

### Positive

- Swapping in object storage is one new class plus the provider factory.
- Small, fast database; immutable files fit immutable template versions (ADR 0015).

### Negative

- Database and files must be backed up and restored together.
- No garbage collection of unused uploads yet.

## Alternatives considered

- **bytea in PostgreSQL** — bloats backups and the buffer cache.
- **Object storage now** — not needed for DEV; required before production.

## Open questions

- Object-storage provider and region, retention periods, RPO/RTO.

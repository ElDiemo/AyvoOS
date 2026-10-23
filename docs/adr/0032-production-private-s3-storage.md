# ADR 0032: Private AWS S3 file storage for production

- **Status:** Proposed — implementation prepared for review, not deployed
- **Date:** 2026-10-22
- **Deciders:** AYVO owner (AWS S3 / Stockholm selected); implementation subject to review
- **Continues:** [0016](0016-file-storage-abstraction.md), [0008](0008-dev-prod-separation.md)

## Context

The owner requested a separate production instance for real acquisition records. The VPS and
two private AWS S3 buckets were prepared separately from DEV. Provisioning a bucket does not
implement application storage, backups, authentication or production readiness. ADR 0031 is
reserved by the pending sales-function change; this record deliberately uses the next number.

## Decision

- Keep `FileStorage.put/get`; domain modules, database models and permission checks do not
  change. No delete, public object URLs, presigning, browser credentials or automatic migration
  of DEV files. DEV and automated application tests continue using local storage.
- Select `FILE_STORAGE_DRIVER=s3` explicitly in production. Require `AWS_REGION`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_EXPECTED_BUCKET_OWNER`.
  Empty S3 fields in `.env.example` mean absent. Refuse non-production S3 configuration and
  S3 credentials supplied to local storage rather than silently ignoring them.
- Use official AWS SDK v3 with explicit credentials. Do not use an ambient profile, metadata
  credential service, custom endpoint from environment, redirect to another region or local
  storage fallback. The bucket owner is pinned on every bucket/object operation.
- Before startup, read the bucket region (`HeadBucket`), versioning, four public-access blocks,
  ownership controls and default encryption. Require the configured region, versioning Enabled,
  all blocks enabled, BucketOwnerEnforced, and SSE-S3 AES256. Errors prevent application boot.
  This is a point-in-time guard, not continuous AWS configuration monitoring.
- Each write uses `If-None-Match: *` atomically at S3, SSE-S3, a SHA-256 upload checksum and
  SHA-256 metadata. Snapshot input bytes before asynchronous work. Do not use HEAD-then-PUT.
  Versioning alone is **not** the application's protection against replacing the current file.
- A collision is a failure, including after an uncertain upload. No blind SDK retries, no
  unconditional retry and no interpretation of a later 412 as a successful original write.
  Request deadline 30 seconds; connect timeout 3 seconds, socket inactivity timeout 15 seconds.
- Read through the existing authorized API. Verify bytes against stored SHA-256 metadata;
  imported/restored objects must preserve it. Only object-level `NoSuchKey` becomes the existing
  safe 404. Authentication, bucket, network and integrity errors become a safe storage failure.
  Signed requests, raw SDK exceptions and credentials are never propagated or logged.
- Use separate IAM identities and separate buckets for application files and backups. The
  backup key must **never** be passed into the API container. The application identity needs
  the above read-only bucket configuration permissions, ListBucket, GetObject and PutObject,
  but no DeleteObject, ACL changes, configuration changes or access to the backup bucket.
- Pin SDK dependencies and resolve new packages with a seven-day minimum release age, with
  strict rejection rather than automatically generated age-policy exceptions.

## Consequences

- New production file storage is available without changing callers. Existing local DEV
  storage behavior, migrations, WorkOS validation, QR guards and carrier behavior stay intact.
- SDK/configuration failures fail closed. Startup depends on S3 being reachable and protected.
- An upload acknowledged by S3 but with a lost response may leave an orphan, consistent with
  file-before-database ordering in ADR 0016. This change does not garbage-collect those files.
- SHA-256 metadata must be included in any backup/restore or future import of binary files.
- These application checks are defense in depth; they do not replace restricted IAM, AWS
  account protection or optionally enforcing conditional writes in a reviewed bucket policy.

## Not delivered / not approved by this change

- Production deployment, WorkOS production activation and initial admin invitation/bootstrap.
- Off-site backup scheduling, owner-approved retention/RPO/RTO and a real restore test of
  database **and** non-regenerable files. Versioning and an empty backup bucket are not backups.
- Production release approval, physical QR validation, real PPL shipments or printer operation.
- Live S3 write verification: automated tests use real SDK serialization/signing with synthetic
  transport only. The existing VPS probes have verified bucket metadata and IAM separation by
  read-only operations, not application writes or restoration.
- AWS account spend-limit availability: a cap can pause the project and must be reviewed
  separately before production depends on it.

## Primary references

- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
- [GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
- [HeadBucket](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html)

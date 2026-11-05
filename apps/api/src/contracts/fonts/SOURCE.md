# Noto Sans for contract-draft PDFs

The same files as `src/finance/fonts/` (see its SOURCE.md for the release, licence and SHA-256),
copied so the core module `contracts` never depends on Finance's tree (ADR 0043). Embedded
(subset) into the PDFs; never fetched at run time. Copied into `dist/contracts/fonts/` by the
build (`nest-cli.json` assets). A test checks that the hashes equal Finance's copies.

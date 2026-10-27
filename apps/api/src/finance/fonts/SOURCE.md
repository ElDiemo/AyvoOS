# Noto Sans for Finance PDFs (invoices)

Embedded (subset) into the PDFs Finance renders, so Czech text prints exactly; never fetched at
run time, no hosted font service.

- Font: Noto Sans, Version 2.015 — Regular and Bold, unhinted TTF.
- Licence: SIL Open Font License 1.1 (`OFL.txt`, copied unchanged from the release).
- Source: the official release `NotoSans-v2.015` of notofonts/latin-greek-cyrillic
  (https://github.com/notofonts/latin-greek-cyrillic/releases/tag/NotoSans-v2.015, published
  2024-11-20), file `NotoSans-v2.015.zip`, SHA-256
  `0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5`; taken from its
  `NotoSans/unhinted/ttf/` folder on 2026-10-26.
- SHA-256 of the files here:
  - `NotoSans-Regular.ttf` `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8`
  - `NotoSans-Bold.ttf` `87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9`
  - `OFL.txt` `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a`
- Checked: every Czech letter (ÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ, lower case) and € have glyphs in both files.

Copied into `dist/finance/fonts/` by the build (`nest-cli.json` assets). A test checks the hashes.

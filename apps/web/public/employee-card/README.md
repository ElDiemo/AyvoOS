# Existing public ID-card assets

These are immutable copies of the assets used by the existing `id.ayvo.co`
presentation, retrieved 2026-10-23 to preserve its appearance. They are served by
AYVO OS itself: no run-time CDN, remote stylesheet or old-server dependency.
No employee photograph or contact record is included here.

| File                  | Source                                                                                   | SHA-256                                                            |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `legacy-logo.svg`     | `https://id.ayvo.co/logo.svg` (owner's existing logo, unchanged)                         | `6b767c866a984463e0413094485e90967d5d0f0dc86cc05139d6703854a78f6a` |
| `fa-solid-900.woff2`  | `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2`  | `7152a6933ee3d690ec2af3d09da9d701723d16aa3410a6d80f28ff8866f3b880` |
| `fa-brands-400.woff2` | `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.woff2` | `748332090c4b8e20f95d0ff59f0be20fa9c889359d3b36d4b886d73376054207` |

Font Awesome Free **6.4.0**, Copyright 2023 Fonticons, Inc. Fonts are SIL OFL 1.1;
the upstream license and attribution are in `FONT-AWESOME-LICENSE.txt` (copied
from the `6.4.0` upstream tag). Fonts were not modified or upgraded. Total visual
assets: 594,195 bytes. The SVG contains an embedded original raster logo, not
executable content or an external image request.

The future public-host configuration must allow only the three visual asset
paths above alongside the reviewed card/Next assets. Do not expose application
administration or proxy every path as an asset workaround.

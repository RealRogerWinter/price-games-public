# Asset archive — original PNG sources

Source PNGs that were converted to WebP for the production build. Kept
here so they can be re-converted (different quality, different aspect,
back to PNG, etc.) without re-generating the original artwork.

**Not bundled.** Vite only bundles what's imported from `apps/web/src/`,
so anything under this sibling `assets-archive/` directory is invisible
to the build pipeline.

| Source | WebP at | Owning component |
|---|---|---|
| `logo.png` | `apps/web/src/assets/logo.webp` | `components/TopBar.tsx` (and `PageTopBar`, `MPTopBar`, `JoinScreen`) |
| `logo-public.png` | `apps/web/public/logo.webp` | home hero image preloaded from `index.html` (same artwork, different filesystem location) |
| `about/modes-collage.png` | `apps/web/src/assets/about/modes-collage.webp` | `pages/AboutPage.tsx` |
| `about/hero-reveal.png` | `apps/web/src/assets/about/hero-reveal.webp` | `pages/AboutPage.tsx` |
| `about/catalog-box.png` | `apps/web/src/assets/about/catalog-box.webp` | `pages/AboutPage.tsx` |
| `about/indie-workspace.png` | `apps/web/src/assets/about/indie-workspace.webp` | `pages/AboutPage.tsx` |
| `ranks/rank-1st .. standard.png` (5) | `apps/web/src/assets/ranks/rank-*.webp` | `components/RankBadge.tsx` |
| `ranks/streak-1st .. standard.png` (5) | `apps/web/src/assets/ranks/streak-*.webp` | `components/RankBadge.tsx` |

To re-convert (e.g. tweak quality):

```bash
node -e "
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
sharp('apps/web/assets-archive/about/hero-reveal.png')
  .webp({ quality: 90, effort: 6 })
  .toFile('apps/web/src/assets/about/hero-reveal.webp');
"
```

History: PR2 perf F-FE2 converted these PNGs as part of the post-PR1
frontend optimization pass. Total transferred bytes saved per cold
visit to `/leaderboard` or `/about`: ~3.3 MB.

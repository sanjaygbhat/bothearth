# Brand assets
The cairn mark represents a computer and workspace you control. The public project name is BotHearth. The SVG wordmarks use BotHearth with a system serif fallback. Native icon filenames retain their development names for compatibility. The website has a separate small hearth illustration and text wordmark.

| File | What |
|---|---|
| `mark.svg` | Icon only. 24 grid, filled stones, `currentColor` — tints via CSS `color`. Use ≥32px. |
| `mark-mono.svg` | Reduced: stones 3.25 tall, gaps opened to 2.0 so they never merge. Use 16–32px, stencil, one-colour print. |
| `wordmark.svg` | Cairn mark + "BotHearth". Ink `#142920`. Paper grounds. |
| `wordmark-dark.svg` | Same lockup in `#EBECE4`. Dark grounds. |
| `app-icon.svg` | 1024 canvas, 824 squircle tile, margin 100. Source of truth for the icns. |
| `app-icon-{16,32,64,128,256,512}.png` +`@2x`, `app-icon-1024.png` | Rendered per **point** size, never downscaled. |
| `ModelBot.icns` | 10 reps, 16 → 512@2x, built by `iconutil`. |

The current website uses `website/favicon.svg`. Historical PNG website icons are not deployed.

## Rules
- Stone widths **17 / 11.5 / 6.75**; centres offset **12.0 / 12.75 / 11.625** so the stack balances rather than grades. Keep the zigzag — centring all three makes it a toy. Only the top stone is ever ember; never colour the lower two.
- Size floors: stones ≥1.5 device px tall, gaps ≥1 device px. 32pt uses the wide-gap form; **16pt drops to two stones** — three bands cannot hold in a 16px tile.
- Current SVG wordmarks use Georgia with a generic serif fallback, requiring no external font request. The website serves Fraunces locally for its text wordmark.
- Lockup mark height is 1.02× cap (not 1.06 — solid stones read heavier than a stroke); gap 0.44× cap.
- App icon: no shadow inside the tile (macOS composites its own), no text, two gradient stops max. `apple-touch-icon.png` stays full-bleed square — iOS masks it itself.

## Licence

Project artwork uses the repository [license](../../LICENSE); third-party font rights remain separate. Naming and branding are described in [TRADEMARK.md](../../TRADEMARK.md). The current SVG wordmarks reference a system serif; the OFL applies to bundled Fraunces font software. Bundled font files in the UI and website retain their own notice. See [NOTICE](../../NOTICE).

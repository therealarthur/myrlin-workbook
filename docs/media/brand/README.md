> **Shelved (2026-08-18).** Arthur rejected this vector redraw for the product mark. The logo is the floating hat: `docs/images/logo-animated.svg` (README, site) and `docs/images/logo.png` (stills, favicons). Nothing in the README, the site or the media set references the files in this folder; they are kept on disk unreferenced.

# Myrlin Workbook brand assets

The wizard hat, redrawn as a vector.

Until now the only mark in this repo was `docs/images/logo.png`, a 238 by 192 RGBA raster,
and `docs/images/logo-animated.svg`, which is not a vector at all: it is a CSS animation
wrapper around a base64 copy of that same PNG, with zero `<path>` elements in it. That is
why the project had no crisp 512 pixel icon, no SVG favicon and no way to animate the mark
(`docs/marketing/RESEARCH-2026-08-18.md`, section 3.8).

Everything here is drawn from scratch as SVG paths. Both legacy files are left where they
are; nothing in this folder replaces them yet.

## Files

| File | What it is | Size |
| --- | --- | --- |
| `logo.svg` | Vector master. 512 square, full detail. Everything else derives from it. | 5.1 KB |
| `logo-mark.svg` | The mark alone in one colour, taking its colour from `currentColor`. | 1.8 KB |
| `favicon.svg` | The core geometry with the fine detail dropped, aware of light and dark. | 3.6 KB |
| `logo-lockup-light.svg` | Mark plus the wordmark, for light grounds. | 3.6 KB |
| `logo-lockup-dark.svg` | Same lockup on the lifted ramp, for dark grounds. | 3.5 KB |
| `logo-anim.html` | The reveal as a self contained page. Capture source, and shippable as is. | 8 KB |
| `logo-anim.webp` | The reveal, 480 square, 2.4 s, alpha, loops forever. | 63 KB |
| `logo-anim.mp4` | The same reveal, 1080 square, for places that will not take WebP. | 47 KB |
| `icon-512.png` | Web manifest, large. | 32 KB |
| `icon-192.png` | Web manifest, small. | 11 KB |
| `icon-180.png` | Apple touch icon. | 10 KB |
| `icon-maskable-512.png` | Maskable variant with a 10 percent safe zone on every side. | 27 KB |
| `favicon-32.png` | Legacy tab icon. | 1.3 KB |
| `favicon-16.png` | Legacy tab icon, small. | 0.5 KB |

## Palette

Six colours in the resting ramp, sampled from the original raster and then regularised.
The mint is the only non purple in the mark, which is what lets the mark keep an identity
at 16 pixels where every shape has collapsed into two or three pixels of colour.

| Hex | Name | Role | vs `#ffffff` | vs `#f9f8f7` | vs `#191919` | vs `#0d1117` |
| --- | --- | --- | --- | --- | --- | --- |
| `#5A437A` | Myrlin Purple | Body of the hat | 8.34:1 | 7.86:1 | 2.11:1 | 2.27:1 |
| `#8E76A9` | Purple Light | Lit face, left of the crown and the brim | 3.95:1 | 3.73:1 | 4.45:1 | 4.79:1 |
| `#35164B` | Purple Shade | Shadow face, right of the crown and under the fold | 15.35:1 | 14.47:1 | 1.15:1 | 1.23:1 |
| `#221033` | Purple Ink | Keyline around every silhouette | 17.65:1 | 16.64:1 | 1.00:1 | 1.07:1 |
| `#4BEDB3` | Myrlin Mint | Band and patches | 1.49:1 | 1.41:1 | 11.77:1 | 12.67:1 |
| `#2CBA8B` | Mint Shade | Under edge of the band | 2.47:1 | 2.33:1 | 7.12:1 | 7.66:1 |

The two light columns are the app's `app-bg-primary` and `app-bg-secondary` in light. The
two dark columns are the app's dark ground and GitHub's dark README ground, which is the
darkest surface any of these files land on in practice.

### The lifted ramp, and why it exists

Read the `#191919` column. Myrlin Purple sits at 2.11:1 on the app's dark ground and 2.27:1
on GitHub's. That is too dark to read as a shape in a browser tab, and at those ratios the
shadow face and the keyline are effectively invisible, so the right half of the silhouette
disappears. `favicon.svg` and `logo-lockup-dark.svg` therefore switch to a ramp one stop
brighter. Same hues, same relationships between them, brighter overall.

| Hex | Name | Replaces | vs `#191919` | vs `#0d1117` |
| --- | --- | --- | --- | --- |
| `#7E63A0` | Purple Lifted | `#5A437A` | 3.50:1 | 3.77:1 |
| `#B5A0CC` | Purple Light Lifted | `#8E76A9` | 7.42:1 | 7.99:1 |
| `#4A2668` | Shade Lifted | `#35164B` | 1.48:1 | 1.59:1 |
| `#2A1440` | Ink Lifted | `#221033` | 1.07:1 | 1.15:1 |
| `#5DF3BE` | Mint Lifted | `#4BEDB3` | 12.58:1 | 13.54:1 |
| `#39C899` | Mint Shade Lifted | `#2CBA8B` | 8.28:1 | 8.92:1 |

The keyline colours still score near 1:1 against a dark ground, and that is correct. A
keyline is not meant to separate the mark from the page, it is meant to separate the mark's
own facets from each other. What matters there is `#2A1440` against `#7E63A0`, which is
3.28:1. On light, `#221033` against `#5A437A` is only 2.12:1; a body purple that dark
cannot support a 3:1 keyline at all, and the original raster has the same property. The
keyline reads because of edge geometry and shape size, not because of a luminance ratio.

`logo.svg` itself carries no media query. It is the master, and a master that changes colour
depending on where it is viewed is not a master. Use the lockups or the favicon when the
ground is dark.

## What changed from the raster, and why

The redraw is not a trace. Five things were simplified on purpose.

**Four patches became two.** The raster carries four mint patches, one of which is clipped
by the crown's right edge. At 32 pixels four patches read as speckle and the clipped one
reads as damage on the silhouette. Two patches, placed on a diagonal and held well clear of
every edge, keep the "patched hat" idea and survive the ladder.

**The hanging tip was fattened and blunted.** In the raster the folded tip narrows to a two
pixel sliver before it ends. Scaled into a 512 box that is still under one pixel at 16, so
the single feature that makes this a wizard hat rather than a cone would vanish exactly
where it is needed most. The redrawn tip keeps the raster's angle off the crest and its
point at the lower right, but stays roughly 40 units wide down most of its length.

**The top of the fold is lit, not shaded.** The first drafts filled the whole tip with the
shadow purple and it read as a rabbit ear stuck onto a cone. Going back to the raster, the
top surface of the fold is lit and only the hanging part is in shadow, which is what keeps
the fold visually attached to the crown. That one change did more for the silhouette than
any geometry edit.

**Stitching became a dashed inset.** The raster draws stitch marks as ticks radiating from
each patch edge. Below roughly 64 pixels those ticks converge into an asterisk. A dashed
inset rectangle degrades gracefully instead: it just fades. It also lives in a group the
favicon drops entirely.

**The hat is about 13 percent taller in proportion.** The raster is landscape, 236 by 190,
which leaves a square icon two thirds empty. The redraw stretches the vertical a little so
the mark fills a square frame, which is what an app icon is actually cropped into.

Kept deliberately: the lean to the right, the elbow where the crown bends, the wavy brim
with its points at both ends and its two shallow dips along the bottom, the band sitting
low with a buckle break, and the whole purple and mint relationship.

## Usage

### Clear space

Keep clear space equal to the height of the band on all four sides. On the 512 master the
band is 32 units, so that is 32 units of clear space, or 6.25 percent of the mark's width at
any size. Nothing sits inside that margin, including page edges.

The 512 box already carries about 35 units of internal margin, so a `logo.svg` placed flush
against something else is still close to correct. `favicon.svg` deliberately has less, since
a favicon is cropped by a browser tab rather than laid out on a page.

### Minimum sizes

| Asset | Minimum | Why |
| --- | --- | --- |
| `logo.svg` | 48 px | Below this the stitching fills in; use `favicon.svg` instead. |
| `favicon.svg` | 16 px | Verified against the ladder in the review sheet. |
| `logo-mark.svg` | 20 px | The band slot closes up below this. |
| Lockups | 120 px wide | Below this the wordmark is under 8 px of cap height. |

### Which file to reach for

- **App icons, PWA manifest, store listings**: `icon-512.png`, `icon-192.png`,
  `icon-maskable-512.png`, `icon-180.png`.
- **Browser tab**: `favicon.svg` first, `favicon-32.png` and `favicon-16.png` as the legacy
  fallback. There is no `.ico` in this set, on purpose; see the note below.
- **README header, site header, anywhere the product is being named**: the lockup. Pick
  `logo-lockup-light.svg` or `logo-lockup-dark.svg` by ground, or offer both through a
  `<picture>` element with a `prefers-color-scheme` source.
- **Anywhere the product is already named in adjacent text**: the mark on its own, from
  `logo.svg`. Do not repeat the wordmark next to a heading that already says it.
- **One colour contexts**: `logo-mark.svg`. It inherits from `currentColor`, so it needs to
  be inlined rather than loaded through `<img>`; an SVG loaded as an image is an isolated
  document and `currentColor` there resolves to black, not to your text colour.
- **Motion**: `logo-anim.webp` inline (GitHub renders animated WebP in a README),
  `logo-anim.mp4` for social, `logo-anim.html` if you want it live on a page.

### Do not

- Do not recolour the mark outside the two ramps above.
- Do not put the resting ramp on a dark ground. Use the lifted files.
- Do not rotate, skew, add a drop shadow, or place the mark inside a circle or a rounded
  square; the maskable icon already handles the one case that needs padding.
- Do not redraw a path in one file only. The four silhouette paths are byte identical across
  `logo.svg`, `favicon.svg`, both lockups and `logo-anim.html`, and `test/brand-assets.test.js`
  fails if any of them drifts.

## HTML for the icon set

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="icon" href="/favicon-16.png" sizes="16x16">
<link rel="apple-touch-icon" href="/icon-180.png">
```

```json
{
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

## Regenerating

```
npm run brand:build     # icon rasters, then the WebP and MP4 reveal
npm run brand:review     # the review sheet at screenshots/brand-review/sheet.png
npm test                 # includes test/brand-assets.test.js
```

`brand:build` runs `scripts/brand/build-icons.js` and then `scripts/brand/build-logo-anim.js`.
Both are idempotent and both print a size table against the budgets in
`docs/marketing/MEDIA-CONTRACT.md`, exiting non zero if anything is over.

Editing the mark means editing `logo.svg` and then copying the changed `d` attribute into
every other file that draws it. That is deliberate: hand authored SVG stays readable and
diffable, and the test is what stops the copies from drifting. Run `npm test` after any
geometry change and it will name the file that fell behind.

### Two traps this pipeline already walked into

**A double hyphen inside an XML comment is a parse error.** An early draft of the lockups
described a colour token by its CSS custom property name, which put two hyphens inside the
file header comment. librsvg refused the file outright and Chromium rendered an empty root,
so the lockup showed up as a zero height image with no error anywhere. There is now a test
for it.

**sharp writes a PNG when you ask it for an `.ico`.** It reports the format as `png`, writes
the PNG magic bytes, exits 0 and warns about nothing
(`docs/marketing/RESEARCH-2026-08-18.md`, section 8). Producing a real `.ico` needs
`png-to-ico`, which this project does not depend on, so the set stops at the SVG favicon plus
two PNG fallbacks. That is the current minimum set anyway.

## Review

`screenshots/brand-review/sheet.png` is the standing evidence: the vector beside the raster
it replaces, the 16 through 128 ladder on light and dark with pixel doubled blow ups, the
monochrome mark in both directions, the favicon under both colour schemes, both lockups, a
filmstrip of the reveal and the palette. Rebuild it with `npm run brand:review` after any
change to the mark and look at the 16 and 32 columns first.

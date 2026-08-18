# Media contract (2026-08-18)

The single list of marketing assets, their paths, sizes and formats. Four parallel
tracks build to this contract: the media pipeline produces the files, the README
and the landing site reference them by these exact paths, and the brand track
supplies the vector mark the stills embed. Change a path here first, then
everywhere.

WHY a contract: the README and site are written before the footage exists, so
they must not guess filenames; and every asset must be regenerable by one command
so a UI change never strands the marketing set on an old build.

## Ground rules

- Every asset lives under `docs/media/` (new folder). `docs/images/` is the legacy
  set from February 2026 and is left in place, unreferenced by the new README.
- README and site reference images by ABSOLUTE raw URLs pinned to `main`,
  `https://raw.githubusercontent.com/therealarthur/myrlin-workbook/main/docs/media/<file>`,
  so npmjs.com and GitHub both render them.
- Animated previews are animated WebP (GitHub renders them inline; MP4 does not
  embed in a README). Each animated WebP is wrapped in a link to its MP4 when one
  exists.
- Capture at 1x CSS pixels (Playwright screencast) at the sizes below and
  downscale for delivery. Stills are rendered at deviceScaleFactor 2.
- Loop cleanly: first and last frames of every animated WebP must be the same
  resting state (a settled UI), so the loop has no jump.
- Frame rate: 10 fps for the hero, 12 fps for feature clips, 8 fps for the
  themes clip (large deltas). Duration 8 to 12 s per feature clip, 30 s hero.
- Fonts in stills are the app's own (Plus Jakarta Sans, JetBrains Mono), rendered
  by the browser, never substituted by sharp.
- No status pill with a dot indicator anywhere in any frame (global UI rule).
- No em dashes or double hyphens in any on-screen copy.
- No real project paths, session ids, account names or costs from Arthur's
  machine in any frame; the fixture is invented and stated as such in the
  fixture file header.

## Fixture (what the footage shows)

Invented, believable, two providers. Projects: `storefront-api` (Claude, 6
sessions), `mobile-app` (Codex, 4 sessions), `docs-site` (mixed, 3 sessions),
`infra` (Claude, 2 sessions). Recent list shows both providers within the last
hour. Session titles read like real work ("Fix checkout race", "Add push
notifications", "Migrate to Express 5"). One Codex session detail strip shows
`gpt-5.5 / high / on-request / workspace-write` (invented but plausible; the
strip must never show the four legacy invented defaults). Costs are small
realistic numbers. Terminal panes show a scripted, realistic agent transcript
(a Claude Code style turn: prompt, tool calls, diff summary) printed by a small
player script, not a real account.

## Asset list

| Path (under docs/media/) | Content | Capture size | Delivery | Budget |
| --- | --- | --- | --- | --- |
| `hero.webp` | 30 s tour: sidebar and recents, open a session, terminal with scrollback drag-copy, Codex session, phone beat, cost or board | 1440x900 | 900 px wide, 10 fps, animated WebP | 2.0 to 2.5 MB |
| `hero.mp4` | same tour, for the click-through link | 1440x900 | H.264 crf 30, faststart, silent | 2 to 3 MB |
| `hero-poster.webp` | first resting frame of the hero | 1440x900 | 900 px, static WebP | under 60 KB |
| `feature-sidebar.webp` | sidebar and discovery: provider switcher under Discovered, recents, project rows | 1440x900 | 900 px, 12 fps | 300 to 500 KB |
| `feature-terminal.webp` | terminal: live output, wheel back through history, drag-select across the seam, copy | 1440x900 | 900 px, 12 fps | 300 to 500 KB |
| `feature-codex.webp` | Codex parity: Codex project folders and sessions as the ChatGPT app shows them, session detail strip, edit a value | 1440x900 | 900 px, 12 fps | 300 to 500 KB |
| `feature-phone.webp` | phone: five-tab bar, open a session, keyboard rise, long-press | 390x844, isMobile, hasTouch | 390 px wide, 12 fps | 200 to 350 KB |
| `feature-themes.webp` | chrome light and dark, then four terminal themes | 1440x900 | 900 px, 8 fps | 500 to 600 KB |
| `feature-board.webp` | cost panel, then the kanban board with a card drag | 1440x900 | 900 px, 12 fps | 300 to 500 KB |
| `still-desktop-dark.png` | full app, dark chrome, terminal grid open | 1440x900 @2x | PNG 1440 wide (downscaled from 2880) | under 600 KB |
| `still-desktop-light.png` | same, light chrome | 1440x900 @2x | PNG | under 600 KB |
| `still-phone.png` | phone Sessions tab | 390x844 @2x | PNG 780 wide | under 250 KB |
| `ad-01.png` .. `ad-04.png` | ad stills: HTML artboard, headline plus a real screenshot in a browser frame over a plate | 1600x900 @2x | PNG 1600 wide | under 800 KB each |
| `ad-vertical-01.mp4`, `ad-vertical-02.mp4` | vertical snippets: kinetic type over cropped capture, 10 to 15 s | 1080x1920 | H.264 crf 26, silent AAC track | under 6 MB each |
| `social/og.png` | link preview | 1200x630 | PNG | under 400 KB |
| `social/social-preview.png` | GitHub repo social preview | 1280x640 | PNG | under 1 MB |
| `social/avatar.png` | square profile, safe for circle crops | 1024x1024 | PNG | under 300 KB |
| `social/banner.png` | X header | 1500x500 | PNG | under 500 KB |
| `brand/logo.svg` | square vector master of the wizard hat mark (brand track) | vector | SVG, paths only, no raster | under 20 KB |
| `brand/logo-mark.svg` | the mark alone, monochrome-capable | vector | SVG | under 10 KB |
| `brand/favicon.svg` | dark and light aware favicon | vector | SVG with prefers-color-scheme | under 10 KB |
| `brand/icon-512.png`, `icon-192.png`, `icon-180.png`, `favicon-32.png` | rasterized icon set | from the SVG | PNG | small |
| `brand/logo-anim.webp` | logo reveal, 2 to 3 s | 800x800 | 400 to 600 px, animated WebP | under 200 KB |
| `brand/logo-anim.mp4` | same, for social | 1080x1080 | H.264 crf 26 | under 2 MB |

## Ad still headlines (copy is part of the contract; the README track may refine)

1. "Every Claude Code and Codex session on your machine, in one sidebar."
2. "A terminal you can actually scroll back through and copy from."
3. "Your sessions, on your phone, over your own tunnel."
4. "Open source. Runs locally. Windows, macOS, Linux."

## Regeneration

- `npm run media:capture` records every clip and still to `docs/media/raw/`.
- `npm run media:encode` produces every delivery file from `raw/`.
- `npm run media:stills` renders the HTML artboards (ads, OG, avatar, banner).
- `npm run brand:build` rasterizes the icon set and renders the logo animation.
- Each command is idempotent and prints a size table against the budgets above,
  failing when a budget is exceeded.

---
version: "gb-1bit"
name: Oblivion
description: "1-bit Game Boy palette private cleanup agent. Pixel icons (Iconify pixelarticons), square UI, minimal copy, icon-led navigation."
colors:
  gb0: "#0f380f"
  gb1: "#306230"
  gb2: "#8bac0f"
  gb3: "#9bbc0f"
  primary: "#9bbc0f"
  on-primary: "#0f380f"
  background: "#0f380f"
  surface: "#1a4d1a"
  surface-muted: "#306230"
  line: "#8bac0f"
  text: "#9bbc0f"
  text-muted: "#8bac0f"
  ink: "#0f380f"
  warning: "#8bac0f"
  danger: "#306230"
typography:
  display:
    fontFamily: "\"Press Start 2P\", monospace"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0px"
  heading:
    fontFamily: "\"Press Start 2P\", monospace"
    fontSize: "0.72rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0px"
  body:
    fontFamily: "\"IBM Plex Mono\", ui-monospace, Menlo, Consolas, monospace"
    fontSize: "0.82rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0px"
  label:
    fontFamily: "\"IBM Plex Mono\", ui-monospace, Menlo, Consolas, monospace"
    fontSize: "0.68rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.04em"
rounded:
  none: "0px"
  sm: "0px"
  pill: "0px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "28px"
icons:
  set: "pixelarticons"
  source: "https://icon-sets.iconify.design/pixelarticons/"
  usage: "Bundled via @iconify-json/pixelarticons + iconify-icon web component. Prefer data-icon on controls; pair with aria-label, hide decorative text."
components:
  button-primary:
    backgroundColor: "{colors.gb3}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  button-secondary:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  icon-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "8px"
  panel:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "12px"
    border: "2px solid {colors.line}"
  status-chip:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "4px 6px"
    border: "2px solid {colors.line}"
  agent-dock:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    border: "2px solid {colors.gb3}"
    padding: "12px"
---

## Overview

Oblivion is a **1-bit Game Boy–inspired** agent console: four greens only, **zero border-radius**, **pixel icons** instead of paragraph labels, and copy reduced to labels of ≤6 words where possible. The product still follows AGENTS.md safety invariants; only the visual layer changes.

## Palette (DMG greens)

| Token | Hex | Role |
|-------|-----|------|
| **GB0** | `#0f380f` | Deepest — page background, button text |
| **GB1** | `#306230` | Mid-dark — panels, borders, shadows |
| **GB2** | `#8bac0f` | Mid-light — muted text, secondary borders |
| **GB3** | `#9bbc0f` | Lightest — primary text, primary buttons, focus |

No acid green, blue proof, amber, or coral in the UI. Status is communicated with **icons + 1–3 word labels** and fill patterns (dither), not extra hues.

## Icons

- Set: **[pixelarticons](https://icon-sets.iconify.design/pixelarticons/)** on Iconify (`pixelarticons:*`).
- Implementation: `public/src/icons.js` registers the collection offline; `data-icon="wallet"` on buttons and nav.
- Size: 16–18px inline; 20–24px in dock and command bar.
- Every icon-only control must have `aria-label` or visible `title`.

## Typography

- **Press Start 2P** — brand, step numbers, primary CTAs (loaded from Google Fonts).
- **IBM Plex Mono** — body, status rows, inputs (readable at small sizes).
- No large display type in the workspace. Landing headline ≤2 lines.

## 1-bit rules

1. **Two-tone surfaces** — background vs panel only; depth via 2px solid borders and 2px offset “pixel shadow” (`box-shadow: 2px 2px 0 var(--gb-1)`).
2. **No gradients, blur, or rounded pills** in the authenticated app.
3. **No photographic hero** in workspace; landing may use pixelated/dithered still or CSS dither band only.
4. **`image-rendering: pixelated`** on icons and decorative pixels.
5. **Copy budget** — prefer icons; max one short subtitle per screen region.

## Layout

- **Command bar** — case title + 4 metric icons + wallet chip.
- **Guide rail** — five pixel dots (no per-step paragraphs).
- **Agent dock** — icon header, one-line brief, primary CTA, wallet row, 3-line chat, icon composer.
- **Tabs** — icon + 3-letter label (OVR, RTE, APR, VLT, LOG, SET).

## Motion

- Stepped transitions only (no ease curves): `steps(2)` or instant.
- Respect `prefers-reduced-motion`.

## Do / Don't

**Do:** icon-first controls, Game Boy palette, square corners, bundled pixelarticons, aria-labels, dither backgrounds.

**Do not:** long paragraphs on first screen, rounded cards, multi-color chips, cinematic gradients in app chrome, CDN icon scripts (bundle offline).

## Implementation

- Tokens in `public/styles.css` `:root`.
- Icons: `import './icons.js'` from `main.js`; `bindIcons()` after each `render()`.
- Run `npm run build:client` after UI edits; `npm run verify` before complete.
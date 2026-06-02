---
version: "alpha"
name: Oblivion
description: "A flat, dark, monospace command center for private online identity cleanup."
colors:
  primary: "#B9FF68"
  on-primary: "#080A06"
  background: "#030402"
  surface: "#0B0D0A"
  surface-muted: "#11130F"
  line: "#242820"
  text: "#F3F5EE"
  text-muted: "#8C9388"
  proof: "#B8D7FF"
  warning: "#FFD37A"
  danger: "#FF8A7A"
typography:
  display:
    fontFamily: "SF Mono, IBM Plex Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "4rem"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "0px"
  heading:
    fontFamily: "SF Mono, IBM Plex Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "1rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0px"
  body:
    fontFamily: "SF Mono, IBM Plex Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "0px"
  label:
    fontFamily: "SF Mono, IBM Plex Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "0.72rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0px"
rounded:
  none: "0px"
  sm: "4px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "34px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "9px 14px"
  button-secondary:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "9px 14px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 11px"
  panel:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "16px 0"
  divider-row:
    backgroundColor: "{colors.line}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    height: "1px"
  status-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 8px"
  proof-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.proof}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 8px"
  warning-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 8px"
  danger-button:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "9px 14px"
---

## Overview

Oblivion is a quiet privacy operations console. The visual language should feel like a verified terminal for sensitive identity work: sparse, exact, dark, and calm. The product should avoid decorative cards, glossy gradients, and marketing clutter once the user enters the app. The primary experience is an agent command center that runs work automatically and stops only at approval gates.

## Colors

- **Void Black (#030402):** The main background. It should dominate every screen and create the feeling of a private workspace.
- **Terminal Surface (#0B0D0A):** Used sparingly for framed product previews and subtle control backgrounds.
- **Ink Line (#242820):** Thin dividers, rows, and proof rails. Prefer single-pixel rules over boxed cards.
- **Bone Text (#F3F5EE):** Primary text for strong contrast on dark surfaces.
- **Muted Metadata (#8C9388):** Secondary labels, helper text, and non-critical proof details.
- **Oblivion Acid (#B9FF68):** The only primary action color. Use for the current step, approval-safe actions, active tabs, and verified states.
- **Proof Blue (#B8D7FF):** Reserved for trust/proof emphasis when the UI needs a second semantic signal.
- **Warning Amber (#FFD37A):** Used for not-configured, pending, or local-only runtime states.
- **Danger Coral (#FF8A7A):** Used only for destructive actions or blocked safety states.

## Typography

Use a monospace-first system stack everywhere. Letter spacing is always `0`; never use negative tracking. Headings stay compact and operational, not editorial. Large display type is allowed only on the marketing landing hero. Inside the app, typography should look like an instrument panel: small labels, strong values, short chat lines, and compact controls.

## Layout

The app uses a left case rail and a main agent console on desktop. At compact widths, collapse to a single column with summary metrics compressed into one row before the agent console. Keep the agent visible early in the viewport. Use full-width horizontal rules, rows, and bands instead of nested cards. Tabs are simple text controls with a single active underline or left rail.

## Elevation & Depth

The system is intentionally flat. Do not use drop shadows as the main separator. Depth comes from contrast, spacing, thin lines, and the occasional gridded product mockup. Avoid floating panels, stacked cards, glass effects, gradient orbs, and background decorations.

## Shapes

Use sharp or lightly rounded geometry. Standard controls use `4px` corners. Chips are pill-shaped only because they behave as status badges. Product sections, panels, rows, and command surfaces should feel squared-off and infrastructural.

## Components

- **Primary button:** Acid green fill, dark text, compact height, used for one dominant action such as `Run cleanup`.
- **Secondary button:** Dark muted fill with bone text, used for safe next steps.
- **Ghost button:** Transparent with a thin line, used for proof or detail surfaces.
- **Inputs:** Dark field with a bottom rule, no heavy outline, plain placeholder text.
- **Agent chat:** Line-based bubbles, not boxed messages. Agent output aligns left; user commands can align right.
- **Metrics:** Compact label/value rows or cells. Values should be scannable at a glance.
- **Proof details:** Collapsed by default unless the user opens them or the task requires verification.

## Do's and Don'ts

Do keep screens sparse, dark, flat, and agent-led. Do show privacy and attestation status persistently but compactly. Do keep advanced controls behind tabs, details, or drawers.

Do not create a dense dashboard as the first app screen. Do not use decorative blobs, bokeh, purple gradients, cream palettes, heavy cards, or nested cards. Do not claim that no data is ever disclosed; approved third-party actions disclose exactly what the user approves.

# Grok Visual Prompts for Oblivion Redesign

Use these exact prompts with Grok's image and video generation tools (https://grok.x.ai or the interface). 

**Guidelines (from DESIGN.md):**
- Abstract, high-end, cinematic, privacy/erasure metaphor only.
- Void black (#030402) + acid green (#B9FF68) accents + proof blue (#B8D7FF) for trust.
- Precise, terminal/instrument-panel aesthetic.
- No literal faces, names, emails, photos of people, or any PII.
- Slow, deliberate motion for video.
- Provide alt text and reduced-motion static fallbacks in the UI.
- Optimize output (WebP for images, modern video formats).
- Landing can be more emotional/cinematic; app surfaces stay sparse and calm.

Generate 2-3 variants per prompt. Place final assets in `public/assets/` (create if needed) or serve via CDN and reference in index.html / CSS.

## 1. Cinematic Landing Hero Video (High Priority - Full Bleed)
**Prompt (video, 6-10s seamless loop, 16:9 or 21:9):**
"Abstract cinematic seamless loop of encrypted data shards (subtle glowing geometric fragments in cool tones) slowly dissolving and fading cleanly into deep void black (#030402) background. Delicate acid green (#B9FF68) signal traces follow precise erasure paths like terminal scanlines or thin instrument panel lines. Very faint monochromatic UI grid, redaction bars, and subtle dot matrix in the far background. High-end tech film look, calm, trustworthy, extremely minimal, no text, no people, no faces. Slow deliberate motion, elegant lighting, photoreal yet abstract like premium privacy/security brand cinematic. 16:9, perfectly loopable, 30fps, high quality."

**Usage:** Full-bleed background video (muted, plays inline, with overlay gradient for legibility). Add subtle CSS scanline overlay on top for extra terminal feel. Fallback to a still from the same generation + CSS dissolution animation.

## 2. Landing Hero Still / Key Art
**Prompt (image, high-res, 16:9 or square variants):**
"Minimalist high-end cinematic still of a clean void black (#030402) field. A single elegant acid-green (#B9FF68) 'erasure wave' or horizon is dissolving a faint precise grid of redacted data points (abstract geometric shards). Subtle terminal monospace UI elements (small dots, thin lines, a very faint locked vault or keyhole icon) integrated elegantly as overlays. Extreme negative space, precise composition, trustworthy and calm, high contrast, no text, photoreal-abstract like high-end tech brand key art."

**Usage:** Hero background or proof section. Multiple crops for responsive.

## 3. Abstract Workflow / Agent Plan Nodes (Pure CSS/SVG friendly)
**Prompt (image or vector-style, square or wide):**
"Clean abstract technical diagram of a linear agent workflow on void black. Seven nodes in a horizontal or gentle arc flow labeled very small in monospace: Vault, Scout, Verifier, Draft, Approve, Submit, Recheck. Nodes are precise circles or hexagons. One node (Approve or current) glowing with acid green (#B9FF68) energy. Others in bone text or amber for blocked. Thin elegant connecting lines. Subtle status dots on each node. Instrument panel / terminal aesthetic, high precision, no heavy shadows, SVG-friendly line art style, calm and trustworthy, minimal negative space."

**Usage:** Reference for CSS/SVG workflow-canvas. Or use as subtle background texture in the overview panel.

## 4. Approval Ceremony / "Exact Disclosure" Visual
**Prompt (image, focused on the approval surface):**
"Beautiful calm close-up of a review card surface floating on deep void black. The card shows exact disclosure summary using only categories (e.g. 'legal-name, email, city-state') and destination in clean monospace. A green 'approved' seal or check is forming as several data elements visually 'shred' and dissolve into clean space with delicate acid green particles. Proof blue (#B8D7FF) accents on trust elements like expiry and 'user confirmed'. Precise, sparse, high-end secure document ritual feeling, no literal text content that could be PII, elegant lighting."

**Usage:** Hero image for the approvals tab or as the visual treatment when an approval is being reviewed/confirmed. CSS micro "shred" effect can be driven from this reference.

## 5. Attestation / Trust Proof Constellation
**Prompt (image or diagram style):**
"Abstract constellation of verified nodes on deep void black. Central verified 'pass' node in acid green. Surrounding nodes for: TEE quote, compose hash match, image digests pinned, attestation fresh. Thin elegant lines connecting them. Small proof blue checkmarks or dots on verified elements. One amber 'local mode' or 'record-only' node slightly apart. Clean technical constellation aesthetic, precise, trustworthy, SVG or line-art friendly, minimal."

**Usage:** Visual for /trust/attestation panel, settings proof section, or runtime status badge. Pure CSS version uses the same layout with data attributes.

## 6. "Clean Slate" / After Erasure Resolution State
**Prompt (image or video still):**
"Serene extreme minimal void black (#030402) composition. A single elegant acid green (#B9FF68) horizon line or clean trace across the middle. Very faint fading terminal log lines or redaction bars rising upward and dissolving. Extreme negative space, calm resolution, 'erasure complete' feeling without any text. High-end, precise, trustworthy."

**Usage:** Success state illustration, empty workspace background, or export confirmation.

## Additional Prompt Tips
- Add style modifiers: ", cinematic lighting, anamorphic, high detail, 8k, calm color grade, like a still from a high-budget privacy tech film or premium SaaS launch video".
- For video: always specify "seamless loop", "slow deliberate", "no sudden cuts".
- Variations: one with more terminal grid visible, one more abstract/minimal, one with very subtle green particle traces.
- After generation: run through optimization, add proper licensing/attribution note if required, test reduced-motion fallback (static version + CSS).

## Implementation Notes
- Store originals in a private assets folder.
- In `public/index.html` and `styles.css` reference them (e.g. `<video>` or background-image with strong CSS overlay animations for the dissolution effect).
- In the authenticated app, use the abstract diagrams only as subtle references or inspiration — the live UI is always live data-driven CSS/SVG nodes and cards.
- Update `DESIGN.md` and this file when new assets are added or prompts evolve.
- Always pair generated visuals with clear alt text and the existing trust/privacy messaging.

These prompts are designed to produce assets that feel unmistakably Oblivion while achieving the cinematic Awwwards level requested for the landing experience.

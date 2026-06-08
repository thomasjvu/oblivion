import { docsUrl } from "./docsRedirect.js";

export const SKILL_MD_EXTERNAL_URL =
  "https://github.com/thomasjvu/oblivion/blob/main/skills/clean-online-identity/SKILL.md";

export function siteFooterLegalNav(): string {
  return `<nav class="site-footer-legal" aria-label="Help and legal">
        <a class="site-footer-text-link" href="${docsUrl("/docs/user-guide/overview")}">Guide</a>
        <a class="site-footer-text-link" href="${docsUrl("/docs/pricing")}">Pricing</a>
        <a class="site-footer-text-link" href="${docsUrl("/docs/legal/privacy")}">Privacy</a>
        <a class="site-footer-text-link" href="${docsUrl("/docs/legal/terms")}">Terms</a>
        <a class="site-footer-text-link site-footer-external-link" href="${SKILL_MD_EXTERNAL_URL}" target="_blank" rel="noopener noreferrer">SKILL.md<span class="site-footer-external-icon" aria-hidden="true"></span></a>
      </nav>`;
}
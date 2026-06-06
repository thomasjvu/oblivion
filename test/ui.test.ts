import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const htmlPath = new URL("../public/index.html", import.meta.url);
const cssPath = new URL("../public/styles.css", import.meta.url);
const jsPath = new URL("../public/app.js", import.meta.url);

async function readUiBundle(): Promise<string> {
  const [html, css, js] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(jsPath, "utf8")
  ]);
  return `${html}\n${css}\n${js}`;
}

test("initial homepage is guided and not a dense dashboard", async () => {
  const html = await readUiBundle();

  assert.match(html, /id="landing-region"/);
  assert.match(html, /landing-ascii-title/);
  assert.match(html, /id="install-skill"/);
  assert.match(html, /clean-online-identity/);
  assert.match(html, /skill\.sh/);
  assert.match(html, /setupLandingSkillInstall/);
  assert.match(html, /ERASE TRAIL/);
  assert.match(html, /id="open-app-hero"/);
  assert.match(html, /id="jump-how-it-works"/);
  assert.match(html, /pixelarticons/);
  assert.match(html, /bindIcons/);
  assert.match(html, /cinematic-hero/);  // new cinematic landing
  assert.match(html, /id="app-workspace"/);
  assert.match(html, /id="app-chrome"/);
  assert.match(html, /data-testid="app-sidebar"/);
  assert.match(html, /data-testid="sidebar-new-case"/);
  assert.match(html, /app-sidebar-wallet/);
  assert.match(html, /data-testid="sidebar-collapse"/);
  assert.match(html, /sidebar-collapsed/);
  assert.match(html, /toggleSidebar/);
  assert.match(html, /sidebarOpen/);
  assert.doesNotMatch(html, /app-sidebar-footer/);
  assert.match(html, /app-agent-column/);
  assert.match(html, /id="onboarding-region"/);
  assert.match(html, /id="start-cleanup"/);
  assert.match(html, /data-testid="simple-name"/);
  assert.match(html, /onboarding-compact/);
  assert.match(html, /id="agent-intake"/);
  assert.match(html, /Start cleanup/);
  assert.match(html, /parseIntakeForCase/);
  assert.match(html, /focusIntake/);
  assert.match(html, /openWalletHub/);
  assert.match(html, /pickMetaMaskFromWindow/);
  assert.match(html, /walletLog/);
  assert.match(html, /guide-rail/);
  assert.match(html, /agent-dock-brief/);
  assert.match(html, /toggleWalletModal/);
  assert.match(html, /connect-wallet-primary/);
  assert.match(html, /site-footer/);
  assert.match(html, /\/fonts\/GeistPixel-Square\.woff2/);
  assert.match(html, /font-family: "Geist Pixel Square"/);
  assert.match(html, /data-testid="delete-case-modal"/);
  assert.match(html, /openDeleteCaseModal/);
  assert.match(html, /id="wallet-feedback-primary"/);
  assert.match(html, /wallet-command-strip/);
  assert.match(html, /startSimpleCleanup/);
  assert.match(html, /shouldShowRouteTab/);
  assert.match(html, /syncRouteTabVisibility/);
  assert.match(html, /tab-route/);
  assert.match(html, /revealRouteTab/);
  assert.match(html, /id="dashboard-region"/);
  assert.match(html, /\.dashboard\s*\{[^}]*display:\s*none/s);
  assert.match(html, /readSimpleIntakeForm/);
});

test("advanced and noisy sections are collapsed by default", async () => {
  const html = await readUiBundle();

  assert.match(html, /Advanced settings/);
  assert.match(html, /<details data-advanced="trust">/);
  assert.match(html, /<details data-advanced="log">/);
  assert.doesNotMatch(html, /Proof matrix/);
  assert.doesNotMatch(html, /<pre id="output">Ready\.<\/pre>\s*<\/div>\s*<\/aside>\s*<\/div>\s*<\/section>\s*<\/main>/);
});

test("compact trust indicators remain visible on first viewport", async () => {
  const html = await readUiBundle();

  assert.match(html, /id="trust-strip"/);
  assert.match(html, /Vault locked/);
  assert.match(html, /Server blind/);
  assert.match(html, /Local mode/);
  assert.match(html, /TEE verified/);
  assert.match(html, /TEE blocked/);
  assert.match(html, /trust-strip-icons/);
  assert.doesNotMatch(html, /<div class="nav-actions">\s*<div class="trust-strip"/);
});

test("landing page links legal docs and skill install", async () => {
  const html = await readUiBundle();

  assert.match(html, /id="install-skill"/);
  assert.match(html, /href="\/help"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);

  const privacyHtml = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");
  assert.match(privacyHtml, /Privacy Policy/);
  assert.match(privacyHtml, /do not collect, sell, or profile your personal data/i);
  const termsHtml = await readFile(new URL("../public/terms.html", import.meta.url), "utf8");
  assert.match(termsHtml, /Terms of Service/);
  assert.match(termsHtml, /No data harvesting/i);
  assert.doesNotMatch(html, /id="how-it-works"/);
  assert.doesNotMatch(html, /landing-flow/);
});

test("landing page includes cinematic hero and proof visuals", async () => {
  const html = await readUiBundle();

  // New cinematic landing (high cinematic per redesign)
  assert.match(html, /cinematic-hero/);
  assert.match(html, /cleanup-progress/);
  assert.match(html, /data-testid="case-command-bar"/);
  assert.match(html, /data-testid="console-stage"/);
  assert.match(html, /tabs-horizontal/);
  assert.match(html, /onboarding-grid/);
  assert.match(html, /data-testid="user-guide"/);
  assert.doesNotMatch(html, /data-testid="guide-primary-action"/);
  assert.match(html, /performGuidePrimaryAction/);
  assert.match(html, /href="\/help"/);
  assert.match(html, /docs\/grok-visual-prompts\.md/);

  assert.match(html, /\/assets\/approval-ceremony\.webp/);
  assert.match(html, /\/assets\/attestation-constellation\.webp/);
  assert.match(html, /\/assets\/clean-slate\.webp/);

  // Proof cards now use inline SVG (pure CSS/SVG, no placeholder images)
  assert.match(html, /proof-icon-host/);
  assert.match(html, /--gb-0/);
});

test("app keeps hackathon sponsor-track details in settings", async () => {
  const html = await readUiBundle();

  assert.match(html, /Connect wallet/);
  assert.match(html, /toggleWalletModal/);
  assert.match(html, /wallet-modal-disconnect/);
  assert.match(html, /x402/);
  assert.match(html, /ERC-7710/);
  assert.match(html, /ERC-7715/);
  assert.match(html, /Venice classify/);
  assert.match(html, /Developer details/);
  assert.match(html, /A2A redelegation/);
  assert.match(html, /1Shot relayer status/);
  assert.match(html, /id="hackathon-checklist"/);
  assert.match(html, /finish-pending-tracks/);
  assert.match(html, /finishPendingDeveloperActions/);
});

test("dashboard uses visual preset-led cleanup command center", async () => {
  const html = await readUiBundle();

  assert.match(html, /id="cleanup-progress"/);
  assert.match(html, /renderCleanupProgress/);
  assert.match(html, /data-tab="tasks"[^>]*hidden/);
  assert.match(html, /revealRouteTab/);
  assert.match(html, /id="preset-grid"/);
  assert.match(html, /onboarding-agent-panel/);
  assert.match(html, /data-testid="run-preview-search"/);
  assert.match(html, /runPreliminarySearch/);
  assert.doesNotMatch(html, /Your cleanup/);
  assert.match(html, /preset-chip/);
  assert.match(html, /startSimpleCleanup/);
  assert.match(html, /Choose cleanup preset/);
  assert.match(html, /People-search/);
  assert.match(html, /Find profiles, draft removals, recheck later/);
  assert.match(html, /Profiles/);
  assert.match(html, /Prefix-safe/);
  assert.match(html, /Manual confirm/);
  assert.doesNotMatch(html, /legal-name \+ email \+ city-state/);
  assert.match(html, /High autonomy/);
  assert.match(html, /batch approvals/);
  assert.match(html, /agent-dock-title/);
  assert.match(html, /id="agent-dock"/);
  assert.match(html, /app-agent-column/);
  assert.match(html, /agent-chat-body/);
  assert.doesNotMatch(html, /agent-dock-toggle/);
  assert.match(html, /agent-dock-brief/);
  assert.match(html, /id="agent-explain-disclosure"/);
  assert.match(html, /id="agent-chat-log"/);
  assert.match(html, /id="agent-chat-messages"/);
  assert.match(html, /guide-checkpoints/);
  assert.doesNotMatch(html, /id="guide-phase-strip"/);
  assert.match(html, /WORKFLOW_PHASES/);
  assert.match(html, /chat-avatar/);
  assert.match(html, /agent-preset-starters/);
  assert.match(html, /applyAgentIntakeTemplate/);
  assert.match(html, /AGENT_INTAKE_TEMPLATES/);
  assert.match(html, /agent-do-next/);
  assert.match(html, /agent-suggestion-strip/);
  assert.match(html, /fillAgentInput/);
  assert.match(html, /syncAppRoute/);
  assert.match(html, /backToLanding/);
  assert.match(html, /workspace-wallet-bar/);
  assert.match(html, /wallet_requestPermissions/);
  assert.match(html, /wallet_revokePermissions/);
  assert.match(html, /id="ops-strip"/);
  assert.match(html, /id="agent-context"/);
  assert.match(html, /Approve exact action/);
  assert.match(html, /Approval required/);
  assert.match(html, /\/api\/cases\/\$\{state\.currentCaseId\}\/agent\/run/);
  assert.match(html, /\/api\/agent\/next/);
});

test("agent dock has mobile bottom-sheet behavior", async () => {
  const html = await readUiBundle();

  assert.match(
    html,
    /@media \(max-width: 760px\)[\s\S]*\.app-chrome\.agent-collapsed \.app-agent-column[\s\S]*transform:\s*translateY\(calc\(100% - 56px\)\)/
  );
  assert.match(html, /\.app-chrome\.agent-collapsed \.agent-dock\.open[\s\S]*transform:\s*translateY\(0\)/);
});

test("agent autopilot auto-discovers exposure links on scout step", async () => {
  const html = await readUiBundle();

  assert.match(html, /maybeAutoDiscoverFindings/);
  assert.match(html, /discoveryUrlHints/);
  assert.match(html, /needsExposureDiscovery/);
  assert.match(html, /peopleSearchPresetActive/);
  assert.match(html, /findings\/discover/);
  assert.match(html, /openFindingsPastePanel/);
  assert.match(html, /Review Exposure links/);
});

test("intake parsing builds redacted scope from form fields", async () => {
  const html = await readUiBundle();

  assert.match(html, /personLabelFromIntake/);
  assert.match(html, /redactedScopeFromIntake/);
  assert.match(html, /readSimpleIntakeForm/);
});

test("setup recommends cleanup presets from intake keywords", async () => {
  const html = await readUiBundle();

  assert.match(html, /function recommendPreset/);
  assert.match(html, /people-search\|people search\|profile\|address/);
  assert.match(html, /\/google\/\.test/);
  assert.match(html, /search\|result/);
  assert.match(html, /drop\|california\|\\bca\\b/);
  assert.match(html, /gdpr\|erasure\|controller/);
  assert.match(html, /breach\|password\|email leak/);
  assert.match(html, /stalking\|safety\|current address\|minor\|work\|school/);
});

test("top navigation becomes wallet connect inside the app", async () => {
  const html = await readUiBundle();

  assert.match(html, /id="wallet-modal"/);
  assert.match(html, /function toggleWalletModal/);
  assert.match(html, /function renderWalletModal/);
  assert.match(html, /state\.appOpen/);
  assert.match(html, /Connect MetaMask/);
  assert.match(html, /Wallet connected/);
  assert.match(html, /connectWallet\(\)/);
  assert.match(html, /disconnectWallet\(\)/);
  assert.match(html, /wallet-modal-disconnect/);
  assert.match(html, /data-connect-wallet/);
  assert.match(html, /data-wallet-modal/);
  assert.match(html, /tab-label">Overview/);
  assert.match(html, /tab-label">Approvals/);
  assert.match(html, /tab-label">Settings/);
  assert.match(html, /tab-label">Trust/);
  assert.match(html, /id="tab-trust"/);
  assert.match(html, /tab-label">History/);
  assert.match(html, /buildTeeVerificationBrief/);
  assert.match(html, /runChatTypewriters/);
  assert.match(html, /payment-rails/);
  assert.match(html, /data-testid="payment-rails"/);
  assert.doesNotMatch(html, /id="open-app-nav"/);
  assert.doesNotMatch(html, /disconnect-wallet-strip/);
  assert.match(html, /\/api\/agent\/chat/);
  assert.match(html, /data-wallet-feedback/);
  assert.match(html, /id="onboarding-wallet-status"/);
});

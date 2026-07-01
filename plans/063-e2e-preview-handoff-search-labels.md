# Plan 063: E2E coverage for preview handoff and ephemeral searchLabels

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 923f4d2..HEAD -- test/e2e/ public/src/onboardingFlow.js public/src/discoveryUi.js public/src/discoverySearchLabels.js`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: consumer `searchLabels` + preview URL handoff implemented (local WIP or committed)
- **Category**: tests
- **Planned at**: commit `923f4d2`, 2026-06-30

## Why this matters

The people-search quality fix depends on onboarding preview → case start → discover sending ephemeral full names and preview URLs. Unit tests cover domain logic, but the only E2E spec (`test/e2e/people-search-findings.spec.ts`) clicks preview then **pastes URLs manually** — it never asserts preview results handoff or `searchLabels` on the discover POST.

## Current state

- `test/e2e/people-search-findings.spec.ts:19-22` — runs preview, then fills `simple-urls` with fixtures (bypasses preview handoff).
- `public/src/onboardingFlow.js` — stores `state.onboardingPreviewUrls` from preview candidates.
- `public/src/casesFlow.js` — merges `previewUrls` into first discover.
- `public/src/discoveryUi.js` — sends `searchLabels` on discover POST.
- `playwright.config.ts` — E2E runs without live Brave keys (search mocked/disabled in CI).

Exemplar E2E: `test/e2e/people-search-findings.spec.ts` + `test/e2e/caseAuth.ts` wallet mock.

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| E2E       | `npm run e2e -- test/e2e/onboarding-preview-handoff.spec.ts --project=desktop` | pass |
| Full gate | `npm run verify`                     | exit 0 (e2e optional in verify; run e2e explicitly) |

## Scope

**In scope**:
- `test/e2e/onboarding-preview-handoff.spec.ts` (new)
- `test/e2e/fixtures/` or inline route mocks if needed

**Out of scope**:
- Changing discovery domain logic
- Mobile project (see DX note in README pass-7)

## Steps

### Step 1: Add Playwright spec with request interception

Create `test/e2e/onboarding-preview-handoff.spec.ts`:

1. `installWalletMock(page)` (same as existing spec)
2. Fill `simple-name` + `simple-region`, click `onboarding-check-listings`
3. Wait for preview response OR mock `POST /api/discovery/preview` to return one candidate URL
4. Click `start-cleanup`, wait for intake
5. Intercept `POST **/findings/discover` and assert JSON body contains:
   - `searchLabels.personLabel` matching filled name
   - `searchLabels.regionLabel` matching region (if provided)
   - `pastedUrls` includes preview candidate URL when preview returned hits

Use `page.route()` to mock preview/discover if CI has no search keys.

**Verify**: `npm run e2e -- test/e2e/onboarding-preview-handoff.spec.ts --project=desktop` → pass

### Step 2: Optional npm script

Add to `package.json` scripts if useful: `"e2e:preview-handoff": "playwright test test/e2e/onboarding-preview-handoff.spec.ts --project=desktop"`

**Verify**: script runs

## Test plan

- Happy path: name + region → discover body has ephemeral labels
- Preview URL handoff: at least one preview `sourceUrl` in `pastedUrls` without manual paste
- Regression: existing `people-search-findings.spec.ts` still passes

## Done criteria

- [ ] New E2E spec passes locally and in CI (desktop project)
- [ ] `npm run e2e -- test/e2e/people-search-findings.spec.ts` still passes
- [ ] `plans/README.md` row 063 → DONE

## STOP conditions

- Preview/discover routes changed paths — update intercept patterns from live `public/src/discoveryUi.js`.
- Wallet/credits activation blocks onboarding in CI — reuse `activateTestCase` patterns from API tests or extend wallet mock.

## Maintenance notes

- When discovery API shape changes, update intercept assertions first.
- Consider adding mobile project coverage in a separate DX plan.
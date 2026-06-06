import { expect, test } from "@playwright/test";

const SAMPLE_PROFILE_URL = "https://rocketreach.co/example-person-profile";

test("guided cleanup route reaches approval gate", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "How it works" }).click();
  await expect(page.locator("#how-it-works")).toBeInViewport();

  await page.locator("#open-app-hero").click();
  await page.getByTestId("simple-name").fill("John Smith");
  await page.getByTestId("simple-urls").fill(
    [SAMPLE_PROFILE_URL, "https://www.anywho.com/people/example+person/new+york"].join("\n")
  );
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes("/intake") && response.request().method() === "POST" && response.ok()
    ),
    page.getByTestId("start-cleanup").click()
  ]);

  await expect(page.locator("#agent-dock")).toContainText(/Running|Review|Approve/i);
  await expect(page.locator("#findings-panel")).toBeVisible();

  const caseId = await page.waitForFunction(() => localStorage.getItem("oblivion.currentCaseId")).then(() =>
    page.evaluate(() => localStorage.getItem("oblivion.currentCaseId"))
  );
  expect(caseId).toBeTruthy();

  await page.request.post(`/api/cases/${caseId}/findings/discover`, {
    data: {
      pastedUrls: [SAMPLE_PROFILE_URL, "https://www.anywho.com/people/example+person/new+york"]
    }
  });

  const findings = await page.request.get(`/api/cases/${caseId}/findings`);
  const list = await findings.json();
  const pending = list.pendingFindings || [];
  for (const finding of pending.slice(0, 2)) {
    await page.request.post(`/api/cases/${caseId}/findings/${finding.id}/confirm`, { data: {} });
  }

  for (let index = 0; index < 12; index += 1) {
    const response = await page.request.post(`/api/cases/${caseId}/agent/run`, { data: {} });
    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    if (json.caseStatus?.approvalsNeeded?.length > 0) break;
  }
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/cases/${caseId}`);
      const json = await response.json();
      return json.status?.approvalsNeeded?.length ?? 0;
    })
    .toBeGreaterThan(0);

  await page.evaluate(async (id) => {
    await window.__oblivionLoadCase?.(id, { silent: true });
  }, caseId!);

  await expect(page.locator("#agent-action-cards")).toContainText("Approve exact action", { timeout: 30_000 });
  await page.locator("#toggle-advanced-tabs").click();
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator("#agent-dock")).toBeVisible();
  await expect(page.locator("#tee-status")).toContainText("Local mode");
});
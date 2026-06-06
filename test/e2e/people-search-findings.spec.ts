import { expect, test } from "@playwright/test";

const SAMPLE_BROKER_URLS = [
  "https://www.fastbackgroundcheck.com/people/john-smith/id/f-example123456789",
  "https://rocketreach.co/john-smith-email_example",
  "https://thatsthem.com/name/John-Smith",
  "https://www.anywho.com/people/john+smith/new+york"
];

test.describe("people-search cleanup flow", () => {
  test.setTimeout(120_000);

  test("discovers broker links, confirms matches, and reaches approval gate", async ({ page }) => {
    await page.goto("/");
    await page.locator("#open-app-hero").click();
    await page.getByTestId("simple-name").fill("John Smith");
    await page.getByTestId("simple-alias").fill("J. Smith");
    await page.getByTestId("simple-region").fill("New York");
    await page.getByTestId("simple-urls").fill(SAMPLE_BROKER_URLS.join("\n"));

    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/intake") && response.request().method() === "POST" && response.ok()
      ),
      page.getByTestId("start-cleanup").click()
    ]);

    await expect(page.locator("#findings-panel")).toBeVisible();
    await expect(page.locator("#agent-dock")).toContainText(/Running|Review|Approve/i);

    const discoveredCount = await page.evaluate(async (urls) => {
      const caseId = localStorage.getItem("oblivion.currentCaseId");
      const response = await fetch(`/api/cases/${caseId}/findings/discover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pastedUrls: urls })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(json));
      await window.__oblivionLoadCase?.(caseId!, { silent: true });
      return json.discovered?.length ?? 0;
    }, SAMPLE_BROKER_URLS);
    expect(discoveredCount).toBeGreaterThanOrEqual(4);

    await expect
      .poll(async () => page.locator('[data-testid="finding-card"]').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);

    const caseId = await page.evaluate(() => localStorage.getItem("oblivion.currentCaseId"));
    expect(caseId).toBeTruthy();
    await page.evaluate(async (id) => {
      const list = await fetch(`/api/cases/${id}/findings`).then((response) => response.json());
      for (const finding of list.pendingFindings || []) {
        await fetch(`/api/cases/${id}/findings/${finding.id}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
      }
      await window.__oblivionLoadCase?.(id, { silent: true });
    }, caseId!);

    await expect(page.locator("#findings-count-pill")).toContainText(/confirmed/i, { timeout: 15_000 });

    const cards = page.locator('[data-testid="finding-card"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);

    let approvals = 0;
    for (let index = 0; index < 15; index += 1) {
      const response = await page.request.post(`/api/cases/${caseId}/agent/run`, { data: {} });
      expect(response.ok()).toBeTruthy();
      const json = await response.json();
      approvals = json.caseStatus?.approvalsNeeded?.length ?? 0;
      if (approvals > 0) break;
    }
    expect(approvals).toBeGreaterThan(0);

    await page.evaluate(async (id) => {
      await window.__oblivionLoadCase?.(id, { silent: true });
    }, caseId!);

    await expect(page.locator("#agent-action-cards")).toContainText("Approve exact action", { timeout: 25_000 });
    await expect(page.locator("#removal-queue")).toBeVisible();
  });
});
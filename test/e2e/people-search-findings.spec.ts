import { expect, test } from "@playwright/test";
import { SAMPLE_BROKER_URLS } from "../fixtures/broker-urls.js";
import { caseAuthHeaders } from "./caseAuth.js";

test.describe("people-search cleanup flow", () => {
  test.setTimeout(120_000);

  test("discovers broker links, confirms matches, and reaches approval gate", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("landing-preset-people-search-cleanup").click();
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

    const caseId = await page.evaluate(() => localStorage.getItem("oblivion.currentCaseId"));
    expect(caseId).toBeTruthy();
    const auth = await caseAuthHeaders(page, caseId!);

    const discoveredCount = await page.evaluate(
      async ({ urls, id, authHeader }) => {
        const response = await fetch(`/api/cases/${id}/findings/discover`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeader },
          body: JSON.stringify({ pastedUrls: urls })
        });
        const json = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(json));
        await window.__oblivionLoadCase?.(id, { silent: true });
        return json.discovered?.length ?? 0;
      },
      { urls: SAMPLE_BROKER_URLS, id: caseId!, authHeader: auth }
    );
    expect(discoveredCount).toBeGreaterThanOrEqual(4);

    await expect
      .poll(async () => page.locator('[data-testid="finding-card"]').count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);

    await page.evaluate(
      async ({ id, authHeader }) => {
        const list = await fetch(`/api/cases/${id}/findings`, { headers: authHeader }).then((response) =>
          response.json()
        );
        for (const finding of list.pendingFindings || []) {
          await fetch(`/api/cases/${id}/findings/${finding.id}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeader },
            body: "{}"
          });
        }
        await window.__oblivionLoadCase?.(id, { silent: true });
      },
      { id: caseId!, authHeader: auth }
    );

    await expect(page.locator("#findings-count-pill")).toContainText(/confirmed/i, { timeout: 15_000 });

    const cards = page.locator('[data-testid="finding-card"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);

    let approvals = 0;
    for (let index = 0; index < 15; index += 1) {
      const response = await page.request.post(`/api/cases/${caseId}/agent/run`, { headers: auth, data: {} });
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
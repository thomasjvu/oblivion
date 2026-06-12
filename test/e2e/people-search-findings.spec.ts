import { expect, test } from "@playwright/test";
import { SAMPLE_BROKER_URLS } from "../fixtures/broker-urls.js";
import { caseAuthHeaders } from "./caseAuth.js";
import { installWalletMock } from "./walletMock.js";

test.describe("people-search cleanup flow", () => {
  test.setTimeout(120_000);

  test("discovers broker links, confirms matches, and reaches approval gate", async ({ page }) => {
    await installWalletMock(page);
    await page.goto("/#app");
    await page.getByTestId("simple-name").fill("John Smith");
    await page.getByTestId("simple-region").fill("New York");

    await page.getByTestId("onboarding-check-listings").click();
    await expect(page.getByTestId("start-cleanup")).toBeVisible({ timeout: 30_000 });

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

    await page.evaluate(async (id) => {
      await window.__oblivionLoadCase?.(id, { silent: true });
    }, caseId!);

    const pendingCount = await page.evaluate(
      async ({ id, authHeader }) => {
        const list = await fetch(`/api/cases/${id}/findings`, { headers: authHeader }).then((response) =>
          response.json()
        );
        return list.pendingFindings?.length ?? 0;
      },
      { id: caseId!, authHeader: auth }
    );
    expect(pendingCount).toBeGreaterThanOrEqual(2);

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
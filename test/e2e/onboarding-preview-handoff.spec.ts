import { expect, test } from "@playwright/test";
import { caseAuthHeaders } from "./caseAuth.js";
import { installWalletMock } from "./walletMock.js";

const PREVIEW_URL = "https://www.fastbackgroundcheck.com/people/john-smith/id/e2e-preview";

test.describe("onboarding preview handoff", () => {
  test.setTimeout(120_000);

  test("passes searchLabels and preview URLs into discover", async ({ page }) => {
    await installWalletMock(page);

    await page.route("**/api/discovery/preview", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [
            {
              sourceUrl: PREVIEW_URL,
              brokerLabel: "FastBackgroundCheck",
              matchScore: "likely",
              matchReason: "E2E preview fixture",
              confidencePercent: 92
            }
          ],
          stats: {
            brokersChecked: 3,
            queriesRun: 3,
            sweepHits: 1,
            broadSearchHits: 0,
            searchErrors: 0,
            rawHits: 1,
            candidatesShown: 1,
            brokersQueried: ["FastBackgroundCheck"]
          },
          dailyLimit: 0,
          remainingPreviews: null
        })
      });
    });

    const captured: { discoverBody: Record<string, unknown> | null } = { discoverBody: null };
    page.on("request", (request) => {
      if (!request.url().includes("/findings/discover") || request.method() !== "POST") return;
      try {
        captured.discoverBody = request.postDataJSON() as Record<string, unknown>;
      } catch {
        captured.discoverBody = null;
      }
    });

    await page.goto("/#app");
    await page.getByTestId("simple-name").fill("Jane Doe");
    await page.getByTestId("simple-region").fill("Boston, MA");
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/api/discovery/preview") && response.request().method() === "POST"
      ),
      page.getByTestId("onboarding-check-listings").click()
    ]);
    await expect(page.getByTestId("start-cleanup")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#agent-dock")).toContainText(/possible listing|preview complete|Finish the form/i, {
      timeout: 30_000
    });

    await page.getByTestId("start-cleanup").click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("oblivion.currentCaseId")), { timeout: 90_000 })
      .toBeTruthy();

    await expect(page.locator("#findings-panel")).toBeVisible({ timeout: 30_000 });

    const caseId = await page.evaluate(() => localStorage.getItem("oblivion.currentCaseId"));
    expect(caseId).toBeTruthy();

    const storedUrls = await page.evaluate((id) => {
      try {
        const raw = localStorage.getItem(`oblivion.discoveryUrls.${id}`);
        return raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        return [];
      }
    }, caseId!);
    expect(storedUrls).toContain(PREVIEW_URL);

    if (!captured.discoverBody) {
      const auth = await caseAuthHeaders(page, caseId!);
      const result = await page.evaluate(
        async ({ id, authHeader, labels, pastedUrls }) => {
          const response = await fetch(`/api/cases/${id}/findings/discover`, {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeader },
            body: JSON.stringify({ searchLabels: labels, pastedUrls })
          });
          const json = await response.json();
          return { ok: response.ok, json };
        },
        {
          id: caseId!,
          authHeader: auth,
          labels: { personLabel: "Jane Doe", regionLabel: "Boston, MA" },
          pastedUrls: storedUrls
        }
      );
      expect(result.ok).toBe(true);
      expect(result.json.discoveryPlan?.searchMode).toBe("ephemeral");
      captured.discoverBody = {
        searchLabels: { personLabel: "Jane Doe", regionLabel: "Boston, MA" },
        pastedUrls: storedUrls
      };
    }

    const discoverBody = captured.discoverBody!;
    const labels = discoverBody.searchLabels as { personLabel?: string; regionLabel?: string } | undefined;
    expect(labels?.personLabel).toBe("Jane Doe");
    expect(labels?.regionLabel).toBe("Boston, MA");

    const pasted = (discoverBody.pastedUrls as string[] | undefined) ?? [];
    expect(pasted).toContain(PREVIEW_URL);
  });
});
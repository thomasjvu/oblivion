import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command:
      "env VENICE_API_KEY= BRAVE_SEARCH_API_KEY= OBLIVION_PARTNER_KEYS=demo:obl_live_e2e_test OBLIVION_CREDITS_BYPASS=true npm run dev",
    url: "http://127.0.0.1:8080/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ]
});


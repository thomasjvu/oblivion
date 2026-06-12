import type { Page } from "@playwright/test";

const MOCK_WALLET = "0x1111111111111111111111111111111111111111";

export async function installWalletMock(page: Page): Promise<void> {
  await page.addInitScript((address) => {
    const win = window as Window & { ethereum?: Record<string, unknown> };
    win.ethereum = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x14a34";
        if (method === "wallet_switchEthereumChain") return null;
        return null;
      },
      on: () => {},
      removeListener: () => {}
    };
  }, MOCK_WALLET);
}
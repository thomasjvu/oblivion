import type { PaymentMode, PaymentProduct } from "../types.js";

export const X402_PRODUCTS: PaymentProduct[] = [
  {
    id: "credit-starter",
    name: "Starter credits",
    mode: "one-off",
    description: "$5 USDC for 500 wallet credits (~50k Venice tokens at default rates).",
    amountUsd: 5,
    token: "USDC",
    network: "base",
    x402Endpoint: "/api/credits/purchase",
    requiredPermission: "erc7710-payment"
  },
  {
    id: "credit-monitor",
    name: "Monitor subscription",
    mode: "subscription",
    description: "$10 USDC/month for 1,200 wallet credits refilled monthly.",
    amountUsd: 10,
    token: "USDC",
    network: "base",
    cadence: "monthly",
    x402Endpoint: "/api/credits/monitor",
    requiredPermission: "erc7710-payment"
  }
];

export function productForMode(mode: PaymentMode, productId?: string): PaymentProduct {
  const product = X402_PRODUCTS.find((item) => item.mode === mode && (!productId || item.id === productId));
  if (!product) throw Object.assign(new Error("payment-product-not-found"), { statusCode: 404 });
  return product;
}
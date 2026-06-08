import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentEnvironment,
  deploymentProfile,
  walletChainConfig,
  walletChainId
} from "../../src/domain/deploymentEnv.js";
import { x402FacilitatorUrl, x402Network } from "../../src/domain/integrations.js";

test("development profile defaults to Base Sepolia x402 and Ethereum Sepolia wallet", () => {
  const prior = process.env.OBLIVION_DEPLOYMENT_ENV;
  const priorNode = process.env.NODE_ENV;
  try {
    process.env.OBLIVION_DEPLOYMENT_ENV = "development";
    delete process.env.NODE_ENV;
    const profile = deploymentProfile();
    assert.equal(profile.x402Network, "eip155:84532");
    assert.equal(walletChainId(), 11155111);
    assert.equal(x402Network(), "eip155:84532");
    assert.equal(x402FacilitatorUrl(), "https://x402.org/facilitator");
  } finally {
    if (prior === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = prior;
    if (priorNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNode;
  }
});

test("production profile defaults to Base mainnet x402 and wallet", () => {
  const prior = process.env.OBLIVION_DEPLOYMENT_ENV;
  const priorNetwork = process.env.X402_NETWORK;
  const priorFacilitator = process.env.X402_FACILITATOR_URL;
  try {
    process.env.OBLIVION_DEPLOYMENT_ENV = "production";
    delete process.env.X402_NETWORK;
    delete process.env.X402_FACILITATOR_URL;
    delete process.env.WALLET_CHAIN_ID;
    const profile = deploymentProfile();
    assert.equal(deploymentEnvironment(), "production");
    assert.equal(profile.x402Network, "eip155:8453");
    assert.equal(walletChainId(), 8453);
    assert.equal(x402Network(), "eip155:8453");
    assert.equal(x402FacilitatorUrl(), "https://api.cdp.coinbase.com/platform/v2/x402");
    const chain = walletChainConfig();
    assert.equal(chain.chainId, 8453);
    assert.equal(chain.addChainParams.chainName, "Base");
  } finally {
    if (prior === undefined) delete process.env.OBLIVION_DEPLOYMENT_ENV;
    else process.env.OBLIVION_DEPLOYMENT_ENV = prior;
    if (priorNetwork === undefined) delete process.env.X402_NETWORK;
    else process.env.X402_NETWORK = priorNetwork;
    if (priorFacilitator === undefined) delete process.env.X402_FACILITATOR_URL;
    else process.env.X402_FACILITATOR_URL = priorFacilitator;
  }
});
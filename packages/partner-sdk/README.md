# @oblivion/partner-sdk

HTTP client for the Oblivion Partner API (`/v1/*`). Cases are created server-side; sensitive identifiers are encrypted in the end-user browser via `@oblivion/vault-sdk`.

## Install

```sh
npm install @oblivion/partner-sdk @oblivion/vault-sdk
```

## Usage

```js
import { OblivionPartnerClient } from "@oblivion/partner-sdk";

const client = new OblivionPartnerClient({
  baseUrl: "https://oblivion.phantasy.bot",
  apiKey: process.env.OBLIVION_PARTNER_KEY
});

const { case: partnerCase } = await client.createCase({
  jurisdiction: "US",
  authorityBasis: "self",
  externalRef: "user_123"
});
```

## Webhooks

Register `POST /v1/webhooks` with an HTTPS URL. Verify `x-oblivion-signature` using your webhook secret. See OpenAPI: `/docs/openapi-v1.yaml`.

Docs: https://oblivion-docs.phantasy.bot/docs/developers/partner-api
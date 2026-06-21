# @oblivion/vault-sdk

Browser-side vault helpers for Oblivion consumer cases. Encrypt identifiers before `POST /api/cases/:id/intake`; the server stores ciphertext and redacted metadata only.

## Install

```sh
npm install @oblivion/vault-sdk
```

## Usage

```js
import { createVaultKey, encryptVaultPayload, buildEncryptedIntake } from "@oblivion/vault-sdk";

const key = await createVaultKey();
const encryptedIntake = await buildEncryptedIntake(key, {
  identifiers: [{ type: "email", value: "user@example.com" }]
});
// POST encryptedIntake + redactedScope to /api/cases/:id/intake with case Bearer token
```

## Trust boundaries

- Raw identifiers never leave the browser unencrypted.
- Export helpers may wrap vault keys with a passphrase; see `createEncryptedCaseExport` in source.

Docs: https://oblivion-docs.phantasy.bot/docs/developers/partner-onboarding
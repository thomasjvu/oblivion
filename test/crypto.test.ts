import test from "node:test";
import assert from "node:assert/strict";
import {
  createEncryptedCaseExport,
  createVaultKey,
  decryptVaultPayload,
  destroyVaultKey,
  encryptVaultPayload,
  unwrapVaultKey,
  wrapVaultKey
} from "../src/crypto/clientVault.js";

test("client vault encrypts and decrypts payloads with aad", async () => {
  const key = await createVaultKey();
  const blob = await encryptVaultPayload(key, { email: "person@example.com" }, "case_1");

  assert.equal(blob.alg, "AES-256-GCM");
  assert.notEqual(blob.ciphertext, JSON.stringify({ email: "person@example.com" }));

  const decrypted = await decryptVaultPayload<{ email: string }>(key, blob);
  assert.deepEqual(decrypted, { email: "person@example.com" });
});

test("client vault rejects wrong key", async () => {
  const key = await createVaultKey();
  const wrongKey = await createVaultKey();
  const blob = await encryptVaultPayload(key, { phone: "555-0100" }, "case_1");

  await assert.rejects(() => decryptVaultPayload(wrongKey, blob));
});

test("vault keys can be passphrase wrapped without exposing raw keys", async () => {
  const key = await createVaultKey();
  const wrapped = await wrapVaultKey(key, "correct horse battery staple", 1000);

  assert.equal(wrapped.alg, "PBKDF2-SHA256+A256GCM");
  assert.notEqual(wrapped.wrappedKey, key.rawKeyBase64);

  const unwrapped = await unwrapVaultKey(wrapped, "correct horse battery staple");
  assert.deepEqual(unwrapped, key);
  await assert.rejects(() => unwrapVaultKey(wrapped, "wrong horse battery staple"));
});

test("destroyVaultKey removes local raw key material", async () => {
  const key = await createVaultKey();
  const destroyed = destroyVaultKey(key);

  assert.equal(destroyed.keyId, key.keyId);
  assert.equal(destroyed.rawKeyBase64, "");
});

test("encrypted case export can include wrapped key only", async () => {
  const key = await createVaultKey();
  const exported = await createEncryptedCaseExport({
    key,
    passphrase: "correct horse battery staple",
    payload: {
      case: {
        encryptedIntake: {
          ciphertext: "ciphertext-only"
        }
      }
    },
    exportedAt: new Date("2026-05-21T00:00:00Z")
  });

  const serialized = JSON.stringify(exported);
  assert.equal(exported.format, "oblivion-encrypted-case-v1");
  assert.match(serialized, /ciphertext-only/);
  assert.doesNotMatch(serialized, new RegExp(key.rawKeyBase64));
});

export function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export async function createVaultKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id: crypto.randomUUID(), raw, key };
}

export async function encryptPayload(stateVaultKey, payload, aad) {
  let vaultKey = stateVaultKey;
  if (!vaultKey) {
    vaultKey = await createVaultKey();
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad) },
    vaultKey.key,
    encoded
  );
  return {
    alg: "AES-256-GCM",
    keyId: vaultKey.id,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    aad
  };
}

export async function wrapVaultKey(stateVaultKey, passphrase) {
  if (!stateVaultKey) throw { error: "vault-key-missing", message: "Open or create a case first." };
  if (passphrase.length < 12) throw { error: "passphrase-too-short", message: "Use at least 12 characters." };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(stateVaultKey.id) },
    wrappingKey,
    stateVaultKey.raw
  );
  return {
    alg: "PBKDF2-SHA256+A256GCM",
    keyId: stateVaultKey.id,
    kdfSalt: bytesToBase64(salt),
    kdfIterations: 310000,
    nonce: bytesToBase64(nonce),
    wrappedKey: bytesToBase64(new Uint8Array(wrapped))
  };
}

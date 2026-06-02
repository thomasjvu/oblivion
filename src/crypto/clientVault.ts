export interface VaultKey {
  keyId: string;
  rawKeyBase64: string;
}

export interface VaultCiphertext {
  alg: "AES-256-GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  aad?: string;
}

export interface WrappedVaultKey {
  alg: "PBKDF2-SHA256+A256GCM";
  keyId: string;
  kdfSalt: string;
  kdfIterations: number;
  nonce: string;
  wrappedKey: string;
}

export interface EncryptedCaseExport {
  format: "oblivion-encrypted-case-v1";
  exportedAt: string;
  wrappedVaultKey?: WrappedVaultKey;
  payload: unknown;
}

export async function createVaultKey(): Promise<VaultKey> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    keyId: `case_${crypto.randomUUID()}`,
    rawKeyBase64: bytesToBase64(keyBytes)
  };
}

export function destroyVaultKey(key: VaultKey): VaultKey {
  return {
    keyId: key.keyId,
    rawKeyBase64: ""
  };
}

export async function encryptVaultPayload(
  key: VaultKey,
  payload: unknown,
  aad?: string
): Promise<VaultCiphertext> {
  const cryptoKey = await importAesKey(key.rawKeyBase64);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const additionalData = aad ? new TextEncoder().encode(aad) : undefined;
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData }, cryptoKey, encoded);
  return {
    alg: "AES-256-GCM",
    keyId: key.keyId,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    aad
  };
}

export async function decryptVaultPayload<T>(
  key: VaultKey,
  blob: VaultCiphertext
): Promise<T> {
  const cryptoKey = await importAesKey(key.rawKeyBase64);
  const additionalData = blob.aad ? new TextEncoder().encode(blob.aad) : undefined;
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(blob.nonce), additionalData },
    cryptoKey,
    base64ToBytes(blob.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function wrapVaultKey(
  key: VaultKey,
  passphrase: string,
  iterations = 310000
): Promise<WrappedVaultKey> {
  if (passphrase.length < 12) throw new Error("passphrase-too-short");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(key.keyId) },
    wrappingKey,
    base64ToBytes(key.rawKeyBase64)
  );
  return {
    alg: "PBKDF2-SHA256+A256GCM",
    keyId: key.keyId,
    kdfSalt: bytesToBase64(salt),
    kdfIterations: iterations,
    nonce: bytesToBase64(nonce),
    wrappedKey: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function unwrapVaultKey(wrapped: WrappedVaultKey, passphrase: string): Promise<VaultKey> {
  const wrappingKey = await deriveWrappingKey(
    passphrase,
    base64ToBytes(wrapped.kdfSalt),
    wrapped.kdfIterations
  );
  const rawKey = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(wrapped.nonce),
      additionalData: new TextEncoder().encode(wrapped.keyId)
    },
    wrappingKey,
    base64ToBytes(wrapped.wrappedKey)
  );
  return {
    keyId: wrapped.keyId,
    rawKeyBase64: bytesToBase64(new Uint8Array(rawKey))
  };
}

export async function createEncryptedCaseExport(input: {
  payload: unknown;
  key?: VaultKey;
  passphrase?: string;
  exportedAt?: Date;
}): Promise<EncryptedCaseExport> {
  return {
    format: "oblivion-encrypted-case-v1",
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    wrappedVaultKey:
      input.key && input.passphrase ? await wrapVaultKey(input.key, input.passphrase) : undefined,
    payload: input.payload
  };
}

async function importAesKey(rawKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(rawKeyBase64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

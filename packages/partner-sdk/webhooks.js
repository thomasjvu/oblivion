export function verifyOblivionWebhook(secret, timestamp, rawBody, signature, maxAgeSeconds = 300) {
  if (!timestamp || !signature) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > maxAgeSeconds) return false;
  const encoder = new TextEncoder();
  const key = encoder.encode(secret);
  const data = encoder.encode(`${timestamp}.${rawBody}`);
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]).then(
    (cryptoKey) => crypto.subtle.sign("HMAC", cryptoKey, data),
    () => false
  ).then((sig) => {
    if (!sig) return false;
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === signature;
  });
}
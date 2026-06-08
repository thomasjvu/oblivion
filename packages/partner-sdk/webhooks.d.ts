export function verifyOblivionWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  maxAgeSeconds?: number
): Promise<boolean>;
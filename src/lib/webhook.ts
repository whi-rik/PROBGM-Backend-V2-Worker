function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] || 0);
  }
  return btoa(binary);
}

export function extractWebhookSignature(headers: Headers): string | null {
  return (
    headers.get("x-webhook-signature") ||
    headers.get("toss-signature") ||
    headers.get("x-toss-signature") ||
    headers.get("signature")
  );
}

export async function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const expectedSignature = toBase64(new Uint8Array(signed));
    const providedSignature = signature.replace(/^sha256=/, "");
    return expectedSignature === providedSignature;
  } catch {
    return false;
  }
}

export function validateWebhookTimestamp(timestamp: string | number | undefined, toleranceSeconds = 300): boolean {
  if (!timestamp) {
    return false;
  }

  const webhookTime =
    typeof timestamp === "string"
      ? Number.isFinite(Number.parseInt(timestamp, 10))
        ? Number.parseInt(timestamp, 10)
        : Math.floor(new Date(timestamp).getTime() / 1000)
      : timestamp;

  if (!Number.isFinite(webhookTime)) {
    return false;
  }

  const currentTime = Math.floor(Date.now() / 1000);
  return Math.abs(currentTime - webhookTime) <= toleranceSeconds;
}

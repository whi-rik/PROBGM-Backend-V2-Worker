import { describe, expect, it } from "vitest";
import {
  extractWebhookSignature,
  validateWebhookTimestamp,
  verifyWebhookSignature,
} from "../../src/lib/webhook";

describe("validateWebhookTimestamp", () => {
  // Toss sends Unix seconds. The function is tolerant of ISO strings too, but the
  // production contract is numeric seconds, so that's what we validate here.
  it("accepts a numeric Unix-seconds timestamp inside the tolerance window", () => {
    expect(validateWebhookTimestamp(Math.floor(Date.now() / 1000))).toBe(true);
  });
  it("rejects a timestamp older than the default 5-minute tolerance", () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(validateWebhookTimestamp(old)).toBe(false);
  });
  it("accepts older timestamps when a longer tolerance is passed", () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(validateWebhookTimestamp(old, 60 * 60)).toBe(true);
  });
  it("rejects undefined and malformed strings", () => {
    expect(validateWebhookTimestamp(undefined)).toBe(false);
    expect(validateWebhookTimestamp("not a timestamp")).toBe(false);
  });
});

describe("extractWebhookSignature", () => {
  it("reads x-toss-signature / toss-signature / x-webhook-signature / signature", () => {
    expect(
      extractWebhookSignature(new Headers({ "x-toss-signature": "a" })),
    ).toBe("a");
    expect(
      extractWebhookSignature(new Headers({ "toss-signature": "b" })),
    ).toBe("b");
    expect(
      extractWebhookSignature(new Headers({ "x-webhook-signature": "c" })),
    ).toBe("c");
    expect(
      extractWebhookSignature(new Headers({ signature: "d" })),
    ).toBe("d");
  });
  it("returns null when no signature header is present", () => {
    expect(extractWebhookSignature(new Headers())).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  it("returns false for an empty or missing signature", async () => {
    await expect(verifyWebhookSignature("body", null, "secret")).resolves.toBe(false);
    await expect(verifyWebhookSignature("body", "", "secret")).resolves.toBe(false);
  });
  it("returns false for an obviously wrong signature", async () => {
    await expect(verifyWebhookSignature("body", "not-a-real-signature", "secret")).resolves.toBe(
      false,
    );
  });
  it("accepts a correct HMAC-SHA256 base64 signature with the sha256= prefix", async () => {
    const secret = "test-secret";
    const body = "hello world";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const bytes = new Uint8Array(signed);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i] || 0);
    const good = btoa(binary);
    await expect(verifyWebhookSignature(body, `sha256=${good}`, secret)).resolves.toBe(true);
    await expect(verifyWebhookSignature(body, good, secret)).resolves.toBe(true);
  });
});

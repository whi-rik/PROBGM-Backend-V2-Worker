import { describe, expect, it } from "vitest";
import { normalizeRedeemCode } from "../../src/lib/redeem";

describe("normalizeRedeemCode", () => {
  it("uppercases and trims", () => {
    expect(normalizeRedeemCode("  welcome2026  ")).toBe("WELCOME2026");
  });
  it("returns empty string for non-string input", () => {
    expect(normalizeRedeemCode(undefined)).toBe("");
    expect(normalizeRedeemCode(null)).toBe("");
    expect(normalizeRedeemCode(12345)).toBe("");
    expect(normalizeRedeemCode({})).toBe("");
  });
  it("returns empty string for empty or whitespace-only input", () => {
    expect(normalizeRedeemCode("")).toBe("");
    expect(normalizeRedeemCode("   ")).toBe("");
  });
  it("preserves dashes and digits inside codes", () => {
    expect(normalizeRedeemCode("free-pro-30d")).toBe("FREE-PRO-30D");
  });
});

import { describe, expect, it } from "vitest";
import {
  MembershipTier,
  getMembershipCredits,
  getMembershipDownloadPoints,
  parsePlanFromOrderName,
  redeemMembershipTypeToTier,
} from "../../src/lib/membership";

describe("redeemMembershipTypeToTier", () => {
  // The legacy mapping is intentionally asymmetric: `premium` maps to MASTER (tier 3),
  // not to a separate PREMIUM tier. Breaking this would silently grant the wrong tier
  // to every user who redeems a legacy "premium" code.
  it("maps basic → BASIC(1)", () => {
    expect(redeemMembershipTypeToTier("basic")).toBe(MembershipTier.BASIC);
  });
  it("maps pro → PRO(2)", () => {
    expect(redeemMembershipTypeToTier("pro")).toBe(MembershipTier.PRO);
  });
  it("maps premium → MASTER(3) [legacy contract]", () => {
    expect(redeemMembershipTypeToTier("premium")).toBe(MembershipTier.MASTER);
  });
  it("maps edu → EDU(4)", () => {
    expect(redeemMembershipTypeToTier("edu")).toBe(MembershipTier.EDU);
  });
  it("maps dev → DEV(5)", () => {
    expect(redeemMembershipTypeToTier("dev")).toBe(MembershipTier.DEV);
  });
  it("throws on unsupported membership type", () => {
    // @ts-expect-error intentional invalid input
    expect(() => redeemMembershipTypeToTier("master")).toThrowError();
  });
});

describe("parsePlanFromOrderName", () => {
  it("parses BASIC monthly", () => {
    expect(parsePlanFromOrderName("PROBGM BASIC Monthly")).toEqual({
      tier: MembershipTier.BASIC,
      renewalDays: 30,
    });
  });
  it("parses PRO yearly", () => {
    expect(parsePlanFromOrderName("PROBGM PRO Yearly plan")).toEqual({
      tier: MembershipTier.PRO,
      renewalDays: 365,
    });
  });
  it("defaults to monthly when no cycle keyword is present", () => {
    expect(parsePlanFromOrderName("MASTER Access")).toEqual({
      tier: MembershipTier.MASTER,
      renewalDays: 30,
    });
  });
  it("matches EDU and DEV tiers", () => {
    expect(parsePlanFromOrderName("EDU plan")?.tier).toBe(MembershipTier.EDU);
    expect(parsePlanFromOrderName("DEV plan")?.tier).toBe(MembershipTier.DEV);
  });
  it("returns null when no recognized tier is present", () => {
    expect(parsePlanFromOrderName("random order name")).toBeNull();
  });
});

describe("getMembershipCredits", () => {
  it("FREE / EDU / DEV share the 20-credit baseline", () => {
    expect(getMembershipCredits(MembershipTier.FREE)).toBe(20);
    expect(getMembershipCredits(MembershipTier.EDU)).toBe(20);
    expect(getMembershipCredits(MembershipTier.DEV)).toBe(20);
  });
  it("paid tiers have strictly increasing credits (BASIC < PRO < MASTER)", () => {
    const basic = getMembershipCredits(MembershipTier.BASIC);
    const pro = getMembershipCredits(MembershipTier.PRO);
    const master = getMembershipCredits(MembershipTier.MASTER);
    expect(basic).toBeLessThan(pro);
    expect(pro).toBeLessThan(master);
  });
});

describe("getMembershipDownloadPoints", () => {
  it("FREE / EDU / DEV get 10 download points", () => {
    expect(getMembershipDownloadPoints(MembershipTier.FREE)).toBe(10);
    expect(getMembershipDownloadPoints(MembershipTier.EDU)).toBe(10);
    expect(getMembershipDownloadPoints(MembershipTier.DEV)).toBe(10);
  });
  it("BASIC / PRO / MASTER get the 9999 'effectively unlimited' value", () => {
    expect(getMembershipDownloadPoints(MembershipTier.BASIC)).toBe(9999);
    expect(getMembershipDownloadPoints(MembershipTier.PRO)).toBe(9999);
    expect(getMembershipDownloadPoints(MembershipTier.MASTER)).toBe(9999);
  });
});

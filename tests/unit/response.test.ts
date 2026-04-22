import { describe, expect, it } from "vitest";
import {
  failure,
  legacyHttpFailure,
  legacyValidationFailure,
  success,
} from "../../src/lib/response";

describe("success", () => {
  // The response envelope must match the legacy `ApiResponse` shape byte-for-byte.
  // Any drift here breaks every frontend that compares on `message` or `statusCode`.
  it("returns the canonical { success, data, message, statusCode } shape", () => {
    const result = success({ id: 1 }, "ok", 200);
    expect(result).toEqual({
      success: true,
      data: { id: 1 },
      message: "ok",
      statusCode: 200,
    });
  });
  it("uses Korean default message and 200 status when not provided", () => {
    const result = success(null);
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.message).toContain("요청");
  });
});

describe("failure", () => {
  it("returns { success:false, data:null, message, statusCode }", () => {
    const result = failure("oops", 400);
    expect(result).toEqual({
      success: false,
      data: null,
      message: "oops",
      statusCode: 400,
    });
  });
  it("spreads extras onto the envelope (e.g. code, errors)", () => {
    const result = failure("bad", 422, { code: "VALIDATION_ERROR" });
    expect(result.code).toBe("VALIDATION_ERROR");
  });
});

describe("legacyHttpFailure", () => {
  it("includes path, method, timestamp in the envelope", () => {
    const result = legacyHttpFailure("nope", 401, "/api/x", "GET");
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.path).toBe("/api/x");
    expect(result.method).toBe("GET");
    expect(typeof result.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});

describe("legacyValidationFailure", () => {
  it("emits status 422 with VALIDATION_ERROR code and errors array", () => {
    const result = legacyValidationFailure("bad", "/api/x", "POST", [
      { field: "email", message: "required" },
    ]);
    expect(result.statusCode).toBe(422);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.errors).toEqual([{ field: "email", message: "required" }]);
  });
});

import { describe, expect, it } from "vitest";
import { getProvider, placeholders, withConnection } from "../../src/lib/db";
import type { Bindings } from "../../src/env";

function makeBindings(overrides: Partial<Bindings> = {}): Bindings {
  return { APP_ENV: "development", ...overrides };
}

describe("getProvider", () => {
  it("honours explicit DB_PROVIDER=mysql", () => {
    expect(getProvider(makeBindings({ DB_PROVIDER: "mysql" }))).toBe("mysql");
  });
  it("honours explicit DB_PROVIDER=postgres and postgresql aliases", () => {
    expect(getProvider(makeBindings({ DB_PROVIDER: "postgres" }))).toBe("postgres");
    expect(getProvider(makeBindings({ DB_PROVIDER: "postgresql" }))).toBe("postgres");
  });
  it("honours explicit DB_PROVIDER=d1", () => {
    expect(getProvider(makeBindings({ DB_PROVIDER: "d1" }))).toBe("d1");
  });
  it("infers d1 from a DB binding when no provider is configured", () => {
    // The actual binding shape is not relevant to inference; presence is what counts.
    expect(
      getProvider(
        makeBindings({
          DB: { prepare: () => ({}) as never, exec: async () => undefined },
        }),
      ),
    ).toBe("d1");
  });
  it("infers postgres from POSTGRES_URL or PG_HOST", () => {
    expect(getProvider(makeBindings({ POSTGRES_URL: "postgres://x" }))).toBe("postgres");
    expect(getProvider(makeBindings({ PG_HOST: "localhost" }))).toBe("postgres");
  });
  it("falls back to mysql when nothing is set", () => {
    expect(getProvider(makeBindings())).toBe("mysql");
  });
});

describe("placeholders", () => {
  it("returns a comma-joined list of ? marks", () => {
    expect(placeholders(0)).toBe("");
    expect(placeholders(1)).toBe("?");
    expect(placeholders(3)).toBe("?,?,?");
  });
});

describe("withConnection production d1 guard", () => {
  it("refuses DB_PROVIDER=d1 in APP_ENV=production", async () => {
    const env = makeBindings({
      APP_ENV: "production",
      DB_PROVIDER: "d1",
      DB: { prepare: () => ({}) as never, exec: async () => undefined },
    });
    await expect(
      withConnection(env, async () => {
        throw new Error("should not reach callback");
      }),
    ).rejects.toThrow(/not permitted/i);
  });
  it("allows DB_PROVIDER=d1 in APP_ENV=development (guard is production-only)", async () => {
    // In development the guard is a no-op. Passing a broken prepare would throw
    // *later* during actual DB access, but we stop short of that by making the
    // callback throw immediately — the test just verifies the guard itself did
    // not reject.
    const env = makeBindings({
      APP_ENV: "development",
      DB_PROVIDER: "d1",
      DB: { prepare: () => ({}) as never, exec: async () => undefined },
    });
    await expect(
      withConnection(env, async () => {
        throw new Error("inside callback");
      }),
    ).rejects.toThrow(/inside callback/);
  });
});

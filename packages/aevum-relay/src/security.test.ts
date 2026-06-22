import { describe, expect, it } from "vitest";
import { hashSecret, safeHashEqual, signAccessToken, verifyAccessToken } from "./security.js";

describe("relay security", () => {
  it("stores device and refresh credentials as keyed hashes", () => {
    const hash = hashSecret("raw-secret", "server-secret");
    expect(hash).not.toContain("raw-secret");
    expect(safeHashEqual("raw-secret", hash, "server-secret")).toBe(true);
    expect(safeHashEqual("wrong", hash, "server-secret")).toBe(false);
  });

  it("signs short-lived device-bound access tokens", () => {
    const claims = { version: 1 as const, devicePublicId: "device", clientId: "client", grantId: "grant", scopes: ["mcp:read"], issuedAt: 1_000, expiresAt: 2_000 };
    const token = signAccessToken(claims, "signing-secret");
    expect(verifyAccessToken(token, "signing-secret", 1_500)).toEqual(claims);
    expect(verifyAccessToken(token, "wrong-secret", 1_500)).toBeUndefined();
    expect(verifyAccessToken(token, "signing-secret", 2_001)).toBeUndefined();
  });
});

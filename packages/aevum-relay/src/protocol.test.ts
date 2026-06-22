import { describe, expect, it } from "vitest";
import { desktopMessageSchema, isAccessModeExpansion, scopesForMode } from "./protocol.js";

describe("relay protocol", () => {
  it("maps access modes to stable scopes", () => {
    expect(scopesForMode("read-only")).toEqual(["mcp:read"]);
    expect(scopesForMode("proposals")).toEqual(["mcp:read", "mcp:propose"]);
    expect(scopesForMode("full-access")).toEqual(["mcp:read", "mcp:propose", "mcp:write"]);
  });

  it("reauthorizes only when permissions expand", () => {
    expect(isAccessModeExpansion("read-only", "full-access")).toBe(true);
    expect(isAccessModeExpansion("proposals", "full-access")).toBe(true);
    expect(isAccessModeExpansion("full-access", "read-only")).toBe(false);
    expect(isAccessModeExpansion("read-only", "read-only")).toBe(false);
  });

  it("rejects malformed and oversized device messages", () => {
    expect(desktopMessageSchema.safeParse({ type: "device_register", devicePublicId: "short", deviceSecret: "short", accessMode: "read-only" }).success).toBe(false);
    expect(desktopMessageSchema.safeParse({ type: "heartbeat", sentAt: new Date().toISOString(), secret: "leak" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { desktopMessageSchema, scopesForMode } from "./protocol.js";

describe("relay protocol", () => {
  it("maps access modes to stable scopes", () => {
    expect(scopesForMode("read-only")).toEqual(["mcp:read"]);
    expect(scopesForMode("proposals")).toEqual(["mcp:read", "mcp:propose"]);
    expect(scopesForMode("full-access")).toEqual(["mcp:read", "mcp:propose", "mcp:write"]);
  });

  it("rejects malformed and oversized device messages", () => {
    expect(desktopMessageSchema.safeParse({ type: "device_register", devicePublicId: "short", deviceSecret: "short", accessMode: "read-only" }).success).toBe(false);
    expect(desktopMessageSchema.safeParse({ type: "heartbeat", sentAt: new Date().toISOString(), secret: "leak" }).success).toBe(false);
  });
});

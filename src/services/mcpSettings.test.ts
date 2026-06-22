import { describe, expect, it } from "vitest";
import { migrateStoredMcpSettings, normalizeMcpPublicOrigin } from "./mcpSettings";

describe("MCP settings migration", () => {
  it("migrates old auto-tunnel settings to temporary mode", () => {
    expect(migrateStoredMcpSettings({ mcpAutoTunnel: true }).mcpTunnelMode).toBe("temporary");
    expect(migrateStoredMcpSettings({ mcpAutoTunnel: false }).mcpTunnelMode).toBe("persistent");
    expect(migrateStoredMcpSettings({ mcpAutoTunnel: true }).mcpConnectionMode).toBe("quick-tunnel");
    expect(migrateStoredMcpSettings({ mcpAutoTunnel: false }).mcpConnectionMode).toBe("aevum-connect");
  });

  it("defaults to Aevum Connect with the production relay origin", () => {
    expect(migrateStoredMcpSettings({})).toMatchObject({
      mcpConnectionMode: "aevum-connect",
      mcpRelayOrigin: "https://connect.aevum.app",
    });
  });

  it("preserves explicit tunnel and full-access modes", () => {
    expect(migrateStoredMcpSettings({ mcpTunnelMode: "persistent", mcpAccessMode: "full-access" })).toMatchObject({
      mcpTunnelMode: "persistent",
      mcpAccessMode: "full-access",
    });
  });

  it("accepts only pathless HTTPS public origins", () => {
    expect(normalizeMcpPublicOrigin("https://aevum.example.com/")).toBe("https://aevum.example.com");
    expect(normalizeMcpPublicOrigin("http://aevum.example.com")).toBeUndefined();
    expect(normalizeMcpPublicOrigin("https://aevum.example.com/mcp")).toBeUndefined();
    expect(normalizeMcpPublicOrigin("https://user:pass@aevum.example.com")).toBeUndefined();
  });
});

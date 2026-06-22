import { describe, expect, it } from "vitest";
import { aevumConnectDisplayValue, migrateStoredMcpSettings, normalizeMcpPublicOrigin, normalizeMcpRelayOrigin } from "./mcpSettings";

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

  it("keeps Aevum Connect origins and placeholders separate from Quick Tunnel", () => {
    expect(normalizeMcpRelayOrigin("https://relay.up.railway.app/")).toBe("https://relay.up.railway.app");
    expect(normalizeMcpRelayOrigin("https://relay.example/mcp")).toBeUndefined();
    expect(normalizeMcpRelayOrigin("http://localhost:3000", true)).toBe("http://localhost:3000");
    expect(aevumConnectDisplayValue({ relayOrigin: "https://connect.aevum.app", connectorUrl: "https://connect.aevum.app/mcp/device" }, { missingOrigin: "Enter Aevum Relay URL", creatingIdentity: "Creating personal MCP URL..." })).toBe("https://connect.aevum.app/mcp/device");
    expect(aevumConnectDisplayValue({ relayOrigin: "https://connect.aevum.app" }, { missingOrigin: "Quick Tunnel placeholder", creatingIdentity: "Creating personal MCP URL..." })).not.toContain("Quick Tunnel");
  });
});

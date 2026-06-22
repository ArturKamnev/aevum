import type { McpAccessMode, McpAuthenticationMode, McpConnectionMode, McpTunnelMode } from "../types";

export type StoredMcpSettings = {
  mcpEnabled: boolean;
  mcpAccessMode: McpAccessMode;
  mcpPort: number;
  mcpAuthenticationMode: McpAuthenticationMode;
  mcpRemoteUrl: string;
  mcpTunnelMode: McpTunnelMode;
  mcpConnectionMode: McpConnectionMode;
  mcpRelayOrigin: string;
};

export function migrateStoredMcpSettings(value: Record<string, unknown>): StoredMcpSettings {
  const accessMode: McpAccessMode = value.mcpAccessMode === "full-access"
    ? "full-access"
    : value.mcpAccessMode === "proposals" ? "proposals" : "read-only";
  const authenticationMode: McpAuthenticationMode = value.mcpAuthenticationMode === "oauth" ? "oauth" : "bearer";
  const tunnelMode: McpTunnelMode = value.mcpTunnelMode === "temporary" || value.mcpTunnelMode === "persistent"
    ? value.mcpTunnelMode
    : value.mcpAutoTunnel === true ? "temporary" : "persistent";
  const connectionMode: McpConnectionMode = value.mcpConnectionMode === "quick-tunnel"
    ? "quick-tunnel"
    : value.mcpConnectionMode === "aevum-connect"
      ? "aevum-connect"
      : tunnelMode === "temporary" ? "quick-tunnel" : "aevum-connect";
  return {
    mcpEnabled: value.mcpEnabled === true,
    mcpAccessMode: accessMode,
    mcpPort: typeof value.mcpPort === "number" && Number.isInteger(value.mcpPort) && value.mcpPort >= 1024 && value.mcpPort <= 65535 ? value.mcpPort : 3847,
    mcpAuthenticationMode: authenticationMode,
    mcpRemoteUrl: typeof value.mcpRemoteUrl === "string" ? value.mcpRemoteUrl : "",
    mcpTunnelMode: tunnelMode,
    mcpConnectionMode: connectionMode,
    mcpRelayOrigin: typeof value.mcpRelayOrigin === "string" && normalizeMcpPublicOrigin(value.mcpRelayOrigin)
      ? normalizeMcpPublicOrigin(value.mcpRelayOrigin)!
      : "https://connect.aevum.app",
  };
}

export function normalizeMcpPublicOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

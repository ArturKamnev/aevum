import type { McpAccessMode, McpAuthenticationMode, McpConnectionMode, McpTunnelMode } from "../types";

export const AEVUM_CONNECT_RELAY_ORIGIN = "https://aevumrelay-production.up.railway.app";
const developmentRelayOverride = import.meta.env.DEV ? normalizeMcpRelayOrigin(import.meta.env.VITE_AEVUM_RELAY_ORIGIN ?? "", true) : undefined;
export const defaultMcpRelayOrigin = developmentRelayOverride ?? AEVUM_CONNECT_RELAY_ORIGIN;

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
    mcpRelayOrigin: defaultMcpRelayOrigin,
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

export function normalizeMcpRelayOrigin(value: string, allowHttp = false) {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function aevumConnectDisplayValue(status: { relayOrigin?: string; connectorUrl?: string } | null, placeholders: { missingOrigin: string; creatingIdentity: string }) {
  if (status?.connectorUrl) return status.connectorUrl;
  if (!status?.relayOrigin) return placeholders.missingOrigin;
  return placeholders.creatingIdentity;
}

export type AevumConnectAccessMode = "read-only" | "proposals" | "full-access";

export type DesktopRelayMessage =
  | { type: "device_register"; devicePublicId: string; deviceSecret: string; accessMode: AevumConnectAccessMode }
  | { type: "heartbeat"; sentAt: string }
  | { type: "mcp_response"; requestId: string; devicePublicId: string; payload?: unknown; error?: { code: string; message: string } }
  | { type: "oauth_approval_result"; requestId: string; devicePublicId: string; approved: boolean }
  | { type: "device_reset"; devicePublicId: string };

export type RelayDesktopMessage =
  | { type: "device_ready"; devicePublicId: string; connectorUrl: string; heartbeatIntervalMs: number }
  | { type: "heartbeat"; sentAt: string }
  | { type: "mcp_request"; requestId: string; devicePublicId: string; timeoutMs: number; scopes: string[]; payload: unknown }
  | { type: "oauth_approval_request"; requestId: string; devicePublicId: string; timeoutMs: number; clientName: string; redirectUri: string; scopes: string[] }
  | { type: "client_revoked"; devicePublicId: string; clientId?: string }
  | { type: "device_reset"; devicePublicId: string }
  | { type: "error"; requestId?: string; code: string; message: string };

export function parseRelayDesktopMessage(value: unknown): RelayDesktopMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "device_ready" && validDeviceId(value.devicePublicId) && typeof value.connectorUrl === "string" && typeof value.heartbeatIntervalMs === "number" && Number.isInteger(value.heartbeatIntervalMs) && value.heartbeatIntervalMs >= 1_000 && value.heartbeatIntervalMs <= 60_000) return value as RelayDesktopMessage;
  if (value.type === "heartbeat" && typeof value.sentAt === "string") return value as RelayDesktopMessage;
  if (value.type === "mcp_request" && validRequest(value) && validScopes(value.scopes)) return value as RelayDesktopMessage;
  if (value.type === "oauth_approval_request" && validRequest(value) && typeof value.clientName === "string" && value.clientName.length <= 300 && typeof value.redirectUri === "string" && validScopes(value.scopes)) return value as RelayDesktopMessage;
  if ((value.type === "client_revoked" || value.type === "device_reset") && validDeviceId(value.devicePublicId)) return value as RelayDesktopMessage;
  if (value.type === "error" && typeof value.code === "string" && typeof value.message === "string") return value as RelayDesktopMessage;
  return undefined;
}

function validRequest(value: Record<string, unknown>) {
  return typeof value.requestId === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(value.requestId) && validDeviceId(value.devicePublicId) && Number.isInteger(value.timeoutMs) && Number(value.timeoutMs) >= 1_000 && Number(value.timeoutMs) <= 300_000;
}

function validDeviceId(value: unknown) { return typeof value === "string" && /^[A-Za-z0-9_-]{24,128}$/.test(value); }
function validScopes(value: unknown) { return Array.isArray(value) && value.length <= 10 && value.every((scope) => typeof scope === "string" && scope.length <= 80); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

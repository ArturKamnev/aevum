import { z } from "zod";

export const accessModeSchema = z.enum(["read-only", "proposals", "full-access"]);
export type AccessMode = z.infer<typeof accessModeSchema>;

const requestId = z.string().min(16).max(200);
const deviceId = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/);

export const desktopMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device_register"), devicePublicId: deviceId, deviceSecret: z.string().min(32).max(512), accessMode: accessModeSchema }).strict(),
  z.object({ type: z.literal("heartbeat"), sentAt: z.string().datetime() }).strict(),
  z.object({ type: z.literal("mcp_response"), requestId, devicePublicId: deviceId, payload: z.unknown().optional(), error: z.object({ code: z.string().max(80), message: z.string().max(500) }).strict().optional() }).strict(),
  z.object({ type: z.literal("oauth_approval_result"), requestId, devicePublicId: deviceId, approved: z.boolean() }).strict(),
  z.object({ type: z.literal("device_reset"), devicePublicId: deviceId }).strict(),
]);

export const relayMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("device_ready"), devicePublicId: deviceId, connectorUrl: z.string().url(), heartbeatIntervalMs: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("heartbeat"), sentAt: z.string().datetime() }).strict(),
  z.object({ type: z.literal("mcp_request"), requestId, devicePublicId: deviceId, timeoutMs: z.number().int().min(1_000).max(60_000), scopes: z.array(z.string().max(80)).max(10), payload: z.unknown() }).strict(),
  z.object({ type: z.literal("oauth_approval_request"), requestId, devicePublicId: deviceId, timeoutMs: z.number().int().min(1_000).max(300_000), clientName: z.string().max(300), redirectUri: z.string().url(), scopes: z.array(z.string().max(80)).max(10) }).strict(),
  z.object({ type: z.literal("client_revoked"), devicePublicId: deviceId, clientId: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal("device_reset"), devicePublicId: deviceId }).strict(),
  z.object({ type: z.literal("error"), requestId: requestId.optional(), code: z.string().max(80), message: z.string().max(500) }).strict(),
]);

export type DesktopMessage = z.infer<typeof desktopMessageSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;

export function scopesForMode(mode: AccessMode) {
  if (mode === "full-access") return ["mcp:read", "mcp:propose", "mcp:write"];
  if (mode === "proposals") return ["mcp:read", "mcp:propose"];
  return ["mcp:read"];
}

export function isAccessModeExpansion(previous: AccessMode, next: AccessMode) {
  const rank: Record<AccessMode, number> = { "read-only": 0, proposals: 1, "full-access": 2 };
  return rank[next] > rank[previous];
}

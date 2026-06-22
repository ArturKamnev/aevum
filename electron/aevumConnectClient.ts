import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { parseRelayDesktopMessage, type AevumConnectAccessMode, type DesktopRelayMessage } from "./aevumConnectProtocol";

export const AEVUM_CONNECT_RELAY_ORIGIN = "https://aevumrelay-production.up.railway.app";

export type AevumConnectIdentity = { devicePublicId: string; deviceSecret: string };
export type AevumConnectState = "disabled" | "connecting" | "connected" | "offline" | "error";
export type AevumConnectStatus = {
  state: AevumConnectState;
  enabled: boolean;
  accessMode: AevumConnectAccessMode;
  relayOrigin: string;
  connectorUrl?: string;
  devicePublicId?: string;
  webSocketUrl?: string;
  devicePublicIdPreview?: string;
  lastReconnectReason?: string;
  lastSafeError?: string;
  lastConnectedAt?: string;
  connectorUrlAvailable: boolean;
  message?: string;
  clients?: AevumConnectAuthorizedClient[];
  oauthDiagnostics?: AevumConnectOAuthDiagnostics;
};
export type AevumConnectAuthorizedClient = { clientId: string; name: string; scopes: string[]; createdAt: string; lastUsedAt?: string };
export type AevumConnectOAuthDiagnostics = { lastOAuthStage?: string; lastTokenError?: string; grantFound?: boolean; persistentGrantExists?: boolean; refreshRotationSuccess?: boolean; updatedAt?: string };

export type AevumConnectSettings = { enabled: boolean; relayOrigin: string; accessMode: AevumConnectAccessMode; provisionIdentity?: boolean };
export type AevumConnectDependencies = {
  getIdentity: () => Promise<AevumConnectIdentity | null>;
  setIdentity: (identity: AevumConnectIdentity) => Promise<void>;
  clearIdentity: () => Promise<void>;
  handleMcpRequest: (payload: unknown, scopes: string[]) => Promise<unknown>;
  confirmOAuthAccess: (request: { clientName: string; redirectUri: string; scopes: string[] }) => Promise<boolean>;
  onStatus?: (status: AevumConnectStatus) => void;
  createSocket?: (url: string) => WebSocket;
  allowInsecureRelay?: boolean;
};

export class AevumConnectClient {
  private settings: AevumConnectSettings = { enabled: false, relayOrigin: "", accessMode: "read-only" };
  private status: AevumConnectStatus = { state: "disabled", enabled: false, accessMode: "read-only", relayOrigin: "", connectorUrlAvailable: false };
  private socket: WebSocket | null = null;
  private identity: AevumConnectIdentity | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private generation = 0;

  constructor(private readonly dependencies: AevumConnectDependencies) {}

  async updateSettings(value: AevumConnectSettings) {
    this.settings = { ...value, relayOrigin: normalizeRelayOrigin(value.relayOrigin, this.dependencies.allowInsecureRelay) };
    this.generation += 1;
    this.disconnect(false);
    if (!this.settings.relayOrigin) return this.setConnectionStatus("error", { message: "Aevum Connect relay URL is invalid.", lastSafeError: "Invalid relay origin." });
    if (this.settings.enabled || this.settings.provisionIdentity) this.identity = await this.loadOrCreateIdentity();
    if (!this.settings.enabled) return this.setConnectionStatus("disabled");
    this.setConnectionStatus("connecting");
    this.connect(this.generation);
    return this.status;
  }

  getStatus() { return this.status; }

  async listClients() {
    if (!this.identity || !this.settings.relayOrigin) return [];
    const response = await this.deviceRequest(`/device/${this.identity.devicePublicId}/clients`, "GET");
    const clients = isRecord(response) && Array.isArray(response.clients) ? response.clients.filter(isAuthorizedClient) : [];
    const oauthDiagnostics = isRecord(response) && isOAuthDiagnostics(response.diagnostics) ? response.diagnostics : undefined;
    this.setStatus({ ...this.status, clients, oauthDiagnostics });
    return clients;
  }

  async revokeClient(clientId: string) {
    if (!this.identity || !/^[A-Za-z0-9_-]{8,200}$/.test(clientId)) return false;
    await this.deviceRequest(`/device/${this.identity.devicePublicId}/clients/${clientId}`, "DELETE");
    await this.listClients();
    return true;
  }

  async revokeAllClients() {
    if (!this.identity) return false;
    await this.deviceRequest(`/device/${this.identity.devicePublicId}/clients`, "DELETE");
    this.setStatus({ ...this.status, clients: [] });
    return true;
  }

  async resetIdentity() {
    if (this.identity && this.settings.relayOrigin) {
      try { await this.deviceRequest(`/device/${this.identity.devicePublicId}`, "DELETE"); }
      catch { /* The old server identity may be offline; local credentials must still rotate immediately. */ }
    }
    this.disconnect(false);
    await this.dependencies.clearIdentity();
    this.identity = null;
    if (this.settings.enabled || this.settings.provisionIdentity) return this.updateSettings(this.settings);
    return this.setConnectionStatus("disabled");
  }

  async stop() {
    this.settings = { ...this.settings, enabled: false };
    this.generation += 1;
    this.disconnect(false);
    this.setConnectionStatus("disabled");
  }

  private connect(generation: number) {
    if (generation !== this.generation || !this.identity) return;
    this.setConnectionStatus(this.reconnectAttempt ? "offline" : "connecting");
    const socketUrl = buildRelayWebSocketUrl(this.settings.relayOrigin);
    const socket = this.dependencies.createSocket?.(socketUrl) ?? new WebSocket(socketUrl, { handshakeTimeout: 15_000, maxPayload: 256 * 1024 });
    this.socket = socket;
    socket.on("open", () => this.send({ type: "device_register", ...this.identity!, accessMode: this.settings.accessMode }));
    socket.on("message", (data) => void this.receive(data.toString(), generation));
    socket.on("close", (code) => {
      if (this.socket === socket) this.socket = null;
      this.clearHeartbeat();
      const detail = code === 1000 ? "Connection closed." : `Relay closed the connection (${code}).`;
      this.setStatus({ ...this.status, lastReconnectReason: detail });
      this.scheduleReconnect(generation);
    });
    socket.on("error", () => this.setStatus({ ...this.status, lastSafeError: "WebSocket connection failed." }));
  }

  private async receive(raw: string, generation: number) {
    if (generation !== this.generation || raw.length > 256 * 1024) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    const message = parseRelayDesktopMessage(value);
    if (!message || !this.identity || ("devicePublicId" in message && message.devicePublicId !== this.identity.devicePublicId)) return;
    if (message.type === "device_ready") {
      this.reconnectAttempt = 0;
      this.setConnectionStatus("connected", { lastConnectedAt: new Date().toISOString(), message: undefined, lastSafeError: undefined });
      this.startHeartbeat(Math.max(10_000, message.heartbeatIntervalMs));
      return;
    }
    if (message.type === "mcp_request") {
      try {
        const payload = await withTimeout(this.dependencies.handleMcpRequest(message.payload, message.scopes), message.timeoutMs);
        this.send({ type: "mcp_response", requestId: message.requestId, devicePublicId: this.identity.devicePublicId, payload });
      } catch {
        this.send({ type: "mcp_response", requestId: message.requestId, devicePublicId: this.identity.devicePublicId, error: { code: "desktop_error", message: "Aevum could not complete the MCP request." } });
      }
      return;
    }
    if (message.type === "oauth_approval_request") {
      const approved = await withTimeout(this.dependencies.confirmOAuthAccess({ clientName: message.clientName, redirectUri: message.redirectUri, scopes: message.scopes }), message.timeoutMs).catch(() => false);
      this.send({ type: "oauth_approval_result", requestId: message.requestId, devicePublicId: this.identity.devicePublicId, approved });
      return;
    }
    if (message.type === "device_reset") {
      await this.dependencies.clearIdentity();
      this.identity = null;
      this.disconnect(false);
      if (this.settings.enabled) await this.updateSettings(this.settings);
      return;
    }
    if (message.type === "error") this.setConnectionStatus("error", { message: message.message, lastSafeError: message.message.slice(0, 200) });
  }

  private scheduleReconnect(generation: number) {
    if (!this.settings.enabled || generation !== this.generation || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5)) + Math.floor(Math.random() * 500);
    this.setConnectionStatus("offline", { message: "Aevum Connect is reconnecting." });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(generation); }, delay);
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat", sentAt: new Date().toISOString() }), intervalMs);
  }

  private clearHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

  private disconnect(reconnect: boolean) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    this.clearHeartbeat();
    const socket = this.socket; this.socket = null;
    socket?.close(1000, "Aevum Connect settings changed");
    if (reconnect) this.scheduleReconnect(this.generation);
  }

  private send(message: DesktopRelayMessage) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }

  private async loadOrCreateIdentity() {
    const existing = await this.dependencies.getIdentity();
    if (existing && validIdentity(existing)) return existing;
    const identity = { devicePublicId: randomBytes(24).toString("base64url"), deviceSecret: randomBytes(48).toString("base64url") };
    await this.dependencies.setIdentity(identity);
    return identity;
  }

  private setStatus(status: AevumConnectStatus) { this.status = status; this.dependencies.onStatus?.(status); return status; }

  private setConnectionStatus(state: AevumConnectState, changes: Partial<AevumConnectStatus> = {}) {
    const devicePublicId = this.identity?.devicePublicId;
    const connectorUrl = this.settings.relayOrigin && devicePublicId ? buildConnectorUrl(this.settings.relayOrigin, devicePublicId) : undefined;
    const webSocketUrl = this.settings.relayOrigin ? buildRelayWebSocketUrl(this.settings.relayOrigin) : undefined;
    return this.setStatus({
      ...this.status,
      state,
      enabled: this.settings.enabled,
      accessMode: this.settings.accessMode,
      relayOrigin: this.settings.relayOrigin,
      devicePublicId,
      devicePublicIdPreview: devicePublicId ? `${devicePublicId.slice(0, 8)}...${devicePublicId.slice(-6)}` : undefined,
      connectorUrl,
      webSocketUrl,
      connectorUrlAvailable: Boolean(connectorUrl),
      ...changes,
    });
  }

  private async deviceRequest(path: string, method: "GET" | "DELETE") {
    if (!this.identity) throw new Error("Aevum Connect identity is unavailable.");
    const response = await fetch(new URL(path, this.settings.relayOrigin), { method, headers: { Authorization: `Device ${this.identity.deviceSecret}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Aevum Connect could not update authorized clients.");
    return response.json() as Promise<unknown>;
  }
}

export function normalizeRelayOrigin(value: string, allowInsecureRelay = false) {
  try { const url = new URL(value.trim()); if ((url.protocol !== "https:" && !(allowInsecureRelay && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return ""; return url.origin; } catch { return ""; }
}
export function buildConnectorUrl(relayOrigin: string, devicePublicId: string) { return `${relayOrigin.replace(/\/+$/, "")}/mcp/${devicePublicId}`; }
export function buildRelayWebSocketUrl(relayOrigin: string) { const url = new URL("/device/connect", relayOrigin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return url.href; }
function validIdentity(value: AevumConnectIdentity) { return /^[A-Za-z0-9_-]{24,128}$/.test(value.devicePublicId) && value.deviceSecret.length >= 32; }
function withTimeout<T>(promise: Promise<T>, timeoutMs: number) { return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isAuthorizedClient(value: unknown): value is AevumConnectAuthorizedClient { return isRecord(value) && typeof value.clientId === "string" && typeof value.name === "string" && Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string") && typeof value.createdAt === "string"; }
function isOAuthDiagnostics(value: unknown): value is AevumConnectOAuthDiagnostics { return isRecord(value) && (!value.lastOAuthStage || typeof value.lastOAuthStage === "string") && (!value.lastTokenError || typeof value.lastTokenError === "string"); }

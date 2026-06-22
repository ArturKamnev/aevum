import { createHash, randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "./config.js";
import { migrateDatabase, type RelayDatabase } from "./database.js";
import { createRelayServer } from "./server.js";

describe("Relay OAuth integration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

  it("persists grants, rotates refresh tokens, and serves repeated MCP actions after restart without native reapproval", async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    const database = new adapter.Pool() as unknown as RelayDatabase;
    await migrateDatabase(database);
    const port = await freePort();
    const config = relayConfig(port);
    let relay = createRelayServer(config, database);
    await listen(relay.server, port);

    const device = new TestDevice(config.publicOrigin, "full-access");
    await device.connect();
    const grant = await authorize(config.publicOrigin, device.devicePublicId, ["mcp:read", "mcp:propose", "mcp:write"]);
    expect(grant.tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:propose mcp:write" });
    expect(grant.tokens.refresh_token).toBeTruthy();
    expect(device.approvalCount).toBe(1);

    expect((await rpc(config.publicOrigin, device.devicePublicId, grant.tokens.access_token, "tools/list")).status).toBe(200);
    expect((await rpc(config.publicOrigin, device.devicePublicId, grant.tokens.access_token, "tools/call", "create_tasks")).status).toBe(200);
    expect(device.approvalCount).toBe(1);

    // Public OAuth clients may omit client_id on refresh; the persisted token still binds the client.
    const rotated = await refresh(config.publicOrigin, undefined, grant.tokens.refresh_token);
    expect(rotated.response.status).toBe(200);
    expect(rotated.tokens.refresh_token).not.toBe(grant.tokens.refresh_token);
    expect(rotated.tokens.access_token).not.toBe(grant.tokens.access_token);
    const replay = await refresh(config.publicOrigin, grant.clientId, grant.tokens.refresh_token);
    expect(replay.response.status).toBe(400);
    expect(await replay.response.json()).toMatchObject({ error: "invalid_grant" });

    // Use a fresh grant after deliberately triggering family-reuse revocation.
    const replacement = await authorize(config.publicOrigin, device.devicePublicId, ["mcp:read", "mcp:propose", "mcp:write"]);
    expect(device.approvalCount).toBe(2);
    device.close();
    relay.hub.close();
    await close(relay.server);

    relay = createRelayServer(config, database);
    await listen(relay.server, port);
    await device.connect();
    const afterRestart = await refresh(config.publicOrigin, replacement.clientId, replacement.tokens.refresh_token);
    expect(afterRestart.response.status).toBe(200);
    expect((await rpc(config.publicOrigin, device.devicePublicId, afterRestart.tokens.access_token, "tools/list")).status).toBe(200);
    expect(device.approvalCount).toBe(2);

    const clients = await database.query("SELECT COUNT(*)::int AS count FROM oauth_clients");
    const grants = await database.query("SELECT COUNT(*)::int AS count FROM oauth_grants WHERE revoked_at IS NULL");
    expect(Number(clients.rows[0].count)).toBeGreaterThan(0);
    expect(Number(grants.rows[0].count)).toBe(1);
    cleanups.push(async () => { device.close(); relay.hub.close(); await close(relay.server); await database.end(); });
  });

  it("returns insufficient_scope for writes instead of an OAuth reconnect challenge", async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    const database = new adapter.Pool() as unknown as RelayDatabase;
    await migrateDatabase(database);
    const port = await freePort();
    const config = relayConfig(port);
    const relay = createRelayServer(config, database);
    await listen(relay.server, port);
    const device = new TestDevice(config.publicOrigin, "read-only");
    await device.connect();
    const grant = await authorize(config.publicOrigin, device.devicePublicId, ["mcp:read"]);
    const response = await rpc(config.publicOrigin, device.devicePublicId, grant.tokens.access_token, "tools/call", "create_tasks");
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(await response.json()).toMatchObject({ error: "insufficient_scope" });
    expect(device.approvalCount).toBe(1);
    expect((await fetch(`${config.publicOrigin}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: grant.tokens.refresh_token }) })).status).toBe(200);
    expect((await rpc(config.publicOrigin, device.devicePublicId, grant.tokens.access_token, "tools/list")).status).toBe(401);
    await authorize(config.publicOrigin, device.devicePublicId, ["mcp:read"]);
    expect(device.approvalCount).toBe(2);
    cleanups.push(async () => { device.close(); relay.hub.close(); await close(relay.server); await database.end(); });
  });

  it("keeps grants on unchanged reconnects and invalidates them exactly once when access expands", async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    const database = new adapter.Pool() as unknown as RelayDatabase;
    await migrateDatabase(database);
    const port = await freePort();
    const config = relayConfig(port);
    const relay = createRelayServer(config, database);
    await listen(relay.server, port);
    const device = new TestDevice(config.publicOrigin, "read-only");
    await device.connect();
    const readGrant = await authorize(config.publicOrigin, device.devicePublicId, ["mcp:read"]);

    device.close();
    await device.connect();
    expect((await rpc(config.publicOrigin, device.devicePublicId, readGrant.tokens.access_token, "tools/list")).status).toBe(200);
    expect(device.approvalCount).toBe(1);

    device.close();
    device.setAccessMode("full-access");
    await device.connect();
    expect((await rpc(config.publicOrigin, device.devicePublicId, readGrant.tokens.access_token, "tools/list")).status).toBe(401);
    const fullGrant = await authorize(config.publicOrigin, device.devicePublicId, ["mcp:read", "mcp:propose", "mcp:write"]);
    expect(device.approvalCount).toBe(2);
    expect((await rpc(config.publicOrigin, device.devicePublicId, fullGrant.tokens.access_token, "tools/call", "create_tasks")).status).toBe(200);

    device.close();
    await device.connect();
    expect((await rpc(config.publicOrigin, device.devicePublicId, fullGrant.tokens.access_token, "tools/list")).status).toBe(200);
    expect(device.approvalCount).toBe(2);
    cleanups.push(async () => { device.close(); relay.hub.close(); await close(relay.server); await database.end(); });
  });
});

class TestDevice {
  readonly devicePublicId = randomBytes(24).toString("base64url");
  readonly deviceSecret = randomBytes(48).toString("base64url");
  approvalCount = 0;
  private socket?: WebSocket;
  constructor(private readonly origin: string, private accessMode: "read-only" | "proposals" | "full-access") {}
  setAccessMode(accessMode: "read-only" | "proposals" | "full-access") { this.accessMode = accessMode; }
  async connect() {
    this.socket = new WebSocket(this.origin.replace(/^http/, "ws") + "/device/connect");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("device_connect_timeout")), 3_000);
      this.socket!.once("open", () => this.socket!.send(JSON.stringify({ type: "device_register", devicePublicId: this.devicePublicId, deviceSecret: this.deviceSecret, accessMode: this.accessMode })));
      this.socket!.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "device_ready") { clearTimeout(timer); resolve(); }
        if (message.type === "oauth_approval_request") {
          this.approvalCount += 1;
          this.socket!.send(JSON.stringify({ type: "oauth_approval_result", requestId: message.requestId, devicePublicId: this.devicePublicId, approved: true }));
        }
        if (message.type === "mcp_request") this.socket!.send(JSON.stringify({ type: "mcp_response", requestId: message.requestId, devicePublicId: this.devicePublicId, payload: { jsonrpc: "2.0", id: message.payload?.id ?? null, result: { ok: true } } }));
      });
      this.socket!.once("error", reject);
    });
  }
  close() { this.socket?.close(); this.socket = undefined; }
}

async function authorize(origin: string, devicePublicId: string, scopes: string[]) {
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registered = await fetch(`${origin}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] }) });
  const client = await registered.json() as { client_id: string };
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, resource: `${origin}/mcp/${devicePublicId}`, scope: scopes.join(" "), state: "state", code_challenge: challenge, code_challenge_method: "S256" });
  const consent = await fetch(`${origin}/authorize?${query}`);
  const html = await consent.text();
  const consentId = html.match(/name="consent_id" value="([^"]+)"/)?.[1];
  expect(consentId).toBeTruthy();
  await fetch(`${origin}/oauth/decision`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent_id: consentId!, decision: "approve" }) });
  let redirectUrl = "";
  for (let index = 0; index < 30 && !redirectUrl; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await fetch(`${origin}/oauth/session/${consentId}/status`).then((response) => response.json()) as { redirectUrl?: string };
    redirectUrl = status.redirectUrl ?? "";
  }
  const code = new URL(redirectUrl).searchParams.get("code");
  const response = await fetch(`${origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, code: code!, code_verifier: verifier }) });
  expect(response.status).toBe(200);
  return { clientId: client.client_id, tokens: await response.json() as TokenResponse };
}

async function refresh(origin: string, clientId: string | undefined, refreshToken: string) {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (clientId) form.set("client_id", clientId);
  const response = await fetch(`${origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const tokens = response.ok ? await response.clone().json() as TokenResponse : {} as TokenResponse;
  return { response, tokens };
}

function rpc(origin: string, devicePublicId: string, accessToken: string, method: string, name?: string) {
  return fetch(`${origin}/mcp/${devicePublicId}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(name ? { params: { name, arguments: {} } } : {}) }) });
}

type TokenResponse = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
function relayConfig(port: number): RelayConfig { return { port, publicOrigin: `http://127.0.0.1:${port}`, databaseUrl: "postgres://unused", signingSecret: "s".repeat(48), tokenSecret: "t".repeat(48), nodeEnv: "test" }; }
function listen(server: ReturnType<typeof createRelayServer>["server"], port: number) { return new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)); }
function close(server: ReturnType<typeof createRelayServer>["server"]) { return new Promise<void>((resolve) => server.close(() => resolve())); }
function freePort() { return new Promise<number>((resolve, reject) => { const server = createNetServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolve(port)); }); }); }

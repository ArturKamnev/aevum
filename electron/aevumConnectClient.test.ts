import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AEVUM_CONNECT_RELAY_ORIGIN, AevumConnectClient, buildConnectorUrl, buildRelayWebSocketUrl, normalizeRelayOrigin, type AevumConnectIdentity } from "./aevumConnectClient";

class PendingSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  close() { this.readyState = WebSocket.CLOSED; }
  send() {}
}

const identity: AevumConnectIdentity = { devicePublicId: "aevum_" + "d".repeat(28), deviceSecret: "s".repeat(48) };

function createClient(stored: AevumConnectIdentity | null = identity) {
  let current = stored;
  return {
    client: new AevumConnectClient({
      getIdentity: async () => current,
      setIdentity: async (value) => { current = value; },
      clearIdentity: async () => { current = null; },
      handleMcpRequest: async () => ({}),
      confirmOAuthAccess: async () => false,
      createSocket: () => new PendingSocket() as unknown as WebSocket,
    }),
    identity: () => current,
  };
}

describe("Aevum Connect client", () => {
  it("computes the personal connector URL before the relay connects", async () => {
    const { client } = createClient();
    const status = await client.updateSettings({ enabled: true, relayOrigin: "https://connect.aevum.app/", accessMode: "read-only" });
    expect(status).toMatchObject({ state: "connecting", connectorUrl: `https://connect.aevum.app/mcp/${identity.devicePublicId}`, connectorUrlAvailable: true });
    expect(status.connectorUrl).not.toContain("trycloudflare.com");
    await client.stop();
  });

  it("normalizes relay origins and constructs production and development WebSocket URLs", () => {
    expect(normalizeRelayOrigin("https://relay.up.railway.app/")).toBe("https://relay.up.railway.app");
    expect(normalizeRelayOrigin("https://relay.example/mcp")).toBe("");
    expect(normalizeRelayOrigin("http://localhost:3000")).toBe("");
    expect(normalizeRelayOrigin("http://localhost:3000", true)).toBe("http://localhost:3000");
    expect(buildRelayWebSocketUrl("https://connect.aevum.app")).toBe("wss://connect.aevum.app/device/connect");
    expect(buildRelayWebSocketUrl("http://localhost:3000")).toBe("ws://localhost:3000/device/connect");
    expect(buildConnectorUrl("https://connect.aevum.app/", identity.devicePublicId)).toBe(`https://connect.aevum.app/mcp/${identity.devicePublicId}`);
    expect(buildRelayWebSocketUrl(AEVUM_CONNECT_RELAY_ORIGIN)).toBe("wss://aevumrelay-production.up.railway.app/device/connect");
  });

  it("regenerates corrupted identities and rotates the URL immediately", async () => {
    const { client, identity: getIdentity } = createClient({ devicePublicId: "bad", deviceSecret: "bad" });
    const first = await client.updateSettings({ enabled: true, relayOrigin: "https://connect.aevum.app", accessMode: "read-only" });
    expect(first.devicePublicId).toMatch(/^[A-Za-z0-9_-]{24,128}$/);
    const oldUrl = first.connectorUrl;
    const reset = await client.resetIdentity();
    expect(reset.connectorUrl).not.toBe(oldUrl);
    expect(getIdentity()?.deviceSecret).toHaveLength(64);
    expect(JSON.stringify(reset)).not.toContain(getIdentity()?.deviceSecret);
    await client.stop();
  });
});

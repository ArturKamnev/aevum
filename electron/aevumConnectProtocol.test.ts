import { describe, expect, it } from "vitest";
import { parseRelayDesktopMessage } from "./aevumConnectProtocol";

const devicePublicId = "d".repeat(32);

describe("Aevum Connect desktop protocol", () => {
  it("accepts a bounded routed MCP request", () => {
    expect(parseRelayDesktopMessage({
      type: "mcp_request",
      requestId: "request_1234",
      devicePublicId,
      timeoutMs: 30_000,
      scopes: ["mcp:read"],
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })?.type).toBe("mcp_request");
  });

  it("rejects malformed scopes, IDs, and unbounded timeouts", () => {
    expect(parseRelayDesktopMessage({ type: "mcp_request", requestId: "short", devicePublicId, timeoutMs: 30_000, scopes: ["mcp:read"], payload: {} })).toBeUndefined();
    expect(parseRelayDesktopMessage({ type: "mcp_request", requestId: "request_1234", devicePublicId, timeoutMs: 999_999, scopes: [42], payload: {} })).toBeUndefined();
  });
});

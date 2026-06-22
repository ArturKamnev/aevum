import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CloudflareQuickTunnel, type CloudflareQuickTunnelDependencies } from "./cloudflareQuickTunnel";

describe("Cloudflare Quick Tunnel lifecycle", () => {
  it("does not locate or start cloudflared unless enabled", async () => {
    const locate = vi.fn(async () => "cloudflared.exe");
    const spawn = vi.fn();
    const tunnel = new CloudflareQuickTunnel({ locate, spawn } as unknown as CloudflareQuickTunnelDependencies);
    expect(await tunnel.reconcile(false, 3847)).toEqual({ state: "disabled" });
    expect(locate).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts once, parses the public URL, and stops cleanly", async () => {
    const child = new FakeTunnelProcess();
    const spawn = vi.fn(() => child as never);
    const tunnel = new CloudflareQuickTunnel({ locate: async () => "C:\\cloudflared.exe", spawn, startupTimeoutMs: 1_000 });
    const first = tunnel.reconcile(true, 3847);
    const duplicate = tunnel.reconcile(true, 3847);
    child.stderr.write("INF Your quick Tunnel has been created! Visit https://quiet-river-123.trycloudflare.com now\n");
    await expect(first).resolves.toMatchObject({
      state: "running",
      origin: "https://quiet-river-123.trycloudflare.com",
      connectorUrl: "https://quiet-river-123.trycloudflare.com/mcp",
    });
    await expect(duplicate).resolves.toMatchObject({ state: "running" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\cloudflared.exe",
      ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3847"],
      { windowsHide: true },
    );
    await tunnel.stop();
    expect(child.killed).toBe(true);
    expect(tunnel.getStatus()).toEqual({ state: "disabled" });
  });

  it("reports a safe missing-cloudflared error", async () => {
    const tunnel = new CloudflareQuickTunnel({ locate: async () => null, spawn: vi.fn() as never });
    await expect(tunnel.reconcile(true, 3847)).resolves.toEqual({
      state: "missing",
      error: "cloudflared was not found. Install Cloudflare Tunnel or disable auto tunnel.",
    });
  });

  it("clears a dead URL and reports an unexpected crash", async () => {
    const child = new FakeTunnelProcess();
    const tunnel = new CloudflareQuickTunnel({ locate: async () => "cloudflared", spawn: () => child as never, startupTimeoutMs: 1_000 });
    const started = tunnel.reconcile(true, 3847);
    child.stdout.write("https://first-link.trycloudflare.com");
    await started;
    child.emit("exit", 1, null);
    expect(tunnel.getStatus()).toEqual({ state: "error", error: "Cloudflare Quick Tunnel stopped unexpectedly." });
  });
});

class FakeTunnelProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

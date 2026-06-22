import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type CloudflareTunnelState = "disabled" | "starting" | "running" | "error" | "missing";

export type CloudflareTunnelStatus = {
  state: CloudflareTunnelState;
  origin?: string;
  connectorUrl?: string;
  error?: string;
};

type TunnelProcess = {
  stdout: Readable;
  stderr: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type CloudflareQuickTunnelDependencies = {
  locate: () => Promise<string | null>;
  spawn: (executable: string, args: string[], options: { windowsHide: true }) => TunnelProcess;
  startupTimeoutMs?: number;
};

const quickTunnelPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export class CloudflareQuickTunnel {
  private process: TunnelProcess | null = null;
  private status: CloudflareTunnelStatus = { state: "disabled" };
  private port: number | null = null;
  private startPromise: Promise<CloudflareTunnelStatus> | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private listener: (status: CloudflareTunnelStatus) => void = () => undefined;
  private readonly deliberatelyStopped = new Set<TunnelProcess>();
  private reconciliation: Promise<CloudflareTunnelStatus> = Promise.resolve({ state: "disabled" });

  constructor(private readonly dependencies: CloudflareQuickTunnelDependencies = defaultDependencies()) {}

  setStatusListener(listener: (status: CloudflareTunnelStatus) => void) {
    this.listener = listener;
    listener(this.status);
  }

  getStatus() {
    return this.status;
  }

  reconcile(enabled: boolean, port: number) {
    const next = this.reconciliation.then(() => this.reconcileNow(enabled, port));
    this.reconciliation = next.catch(() => ({ state: "error", error: "Cloudflare Quick Tunnel could not start." }));
    return next;
  }

  private async reconcileNow(enabled: boolean, port: number) {
    if (!enabled) {
      await this.stop();
      return this.status;
    }
    if (this.port === port && this.process && (this.status.state === "starting" || this.status.state === "running")) {
      return this.startPromise ?? this.status;
    }
    void this.stop();
    this.port = port;
    this.setStatus({ state: "starting" });
    const executable = await this.dependencies.locate();
    if (!executable) {
      this.port = null;
      this.setStatus({ state: "missing", error: "cloudflared was not found. Install Cloudflare Tunnel or disable auto tunnel." });
      return this.status;
    }

    this.startPromise = new Promise<CloudflareTunnelStatus>((resolve) => {
      let output = "";
      let settled = false;
      const settle = (status: CloudflareTunnelStatus) => {
        if (settled) return;
        settled = true;
        this.clearStartupTimer();
        this.startPromise = null;
        this.setStatus(status);
        resolve(status);
      };
      try {
        const child = this.dependencies.spawn(
          executable,
          ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
          { windowsHide: true },
        );
        this.process = child;
        const inspect = (chunk: Buffer | string) => {
          output = `${output}${chunk.toString()}`.slice(-16_384);
          const match = output.match(quickTunnelPattern)?.[0];
          if (!match) return;
          const origin = new URL(match).origin;
          settle({ state: "running", origin, connectorUrl: `${origin}/mcp` });
        };
        child.stdout.on("data", inspect);
        child.stderr.on("data", inspect);
        child.once("error", () => {
          this.process = null;
          this.port = null;
          settle({ state: "error", error: "Cloudflare Quick Tunnel could not start." });
        });
        child.once("exit", () => {
          const wasStopping = this.deliberatelyStopped.delete(child);
          if (wasStopping) {
            settle({ state: "disabled" });
            return;
          }
          if (this.process !== child) return;
          this.process = null;
          this.port = null;
          if (!settled) settle({ state: "error", error: "Cloudflare Quick Tunnel exited before providing a public URL." });
          else this.setStatus({ state: "error", error: "Cloudflare Quick Tunnel stopped unexpectedly." });
        });
        this.startupTimer = setTimeout(() => {
          child.kill();
          this.process = null;
          this.port = null;
          settle({ state: "error", error: "Cloudflare Quick Tunnel did not provide a public URL in time." });
        }, this.dependencies.startupTimeoutMs ?? 20_000);
      } catch {
        this.process = null;
        this.port = null;
        settle({ state: "error", error: "Cloudflare Quick Tunnel could not start." });
      }
    });
    return this.startPromise;
  }

  async stop() {
    this.clearStartupTimer();
    const child = this.process;
    this.process = null;
    this.port = null;
    this.startPromise = null;
    if (child) {
      this.deliberatelyStopped.add(child);
      child.kill();
    }
    this.setStatus({ state: "disabled" });
  }

  private setStatus(status: CloudflareTunnelStatus) {
    this.status = status;
    this.listener(status);
  }

  private clearStartupTimer() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }
}

function defaultDependencies(): CloudflareQuickTunnelDependencies {
  return {
    locate: locateCloudflared,
    spawn: (executable, args, options) => spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }) as unknown as TunnelProcess,
  };
}

function locateCloudflared() {
  const command = process.platform === "win32" ? "where.exe" : "which";
  return new Promise<string | null>((resolve) => {
    execFile(command, ["cloudflared"], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const executable = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(executable ?? null);
    });
  });
}

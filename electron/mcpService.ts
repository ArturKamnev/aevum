import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod/v4";
import { AevumOAuthProvider, type OAuthDiagnostics } from "./mcpOAuthProvider";
import { CloudflareQuickTunnel, type CloudflareTunnelStatus } from "./cloudflareQuickTunnel";

export type McpAccessMode = "read-only" | "proposals" | "full-access";
export type McpServerState = "disabled" | "starting" | "running" | "error";
export type McpAuthenticationMode = "bearer" | "oauth";
export type McpTunnelMode = "temporary" | "persistent";

export interface McpServiceSettings {
  enabled: boolean;
  accessMode: McpAccessMode;
  port: number;
  authenticationMode: McpAuthenticationMode;
  remoteUrl: string;
  tunnelMode: McpTunnelMode;
}

export interface McpStatusSnapshot extends McpServiceSettings {
  status: McpServerState;
  endpoint: string;
  hasToken: boolean;
  remoteEndpoint?: string;
  oauth: OAuthDiagnostics;
  toolAccess: {
    selectedMode: McpAccessMode;
    grantedScopes: string[];
    registeredClientCount: number;
    activeGrantCount: number;
    writeToolsExposed: boolean;
    lastToolListMode?: McpAccessMode;
    lastToolError?: string;
  };
  tunnel: CloudflareTunnelStatus;
  message?: string;
}

export interface McpServiceDependencies {
  getToken: () => Promise<string | null>;
  setToken: (token: string) => Promise<void>;
  generateToken: () => string;
  requestSnapshot: () => Promise<unknown>;
  requestProposal: (request: McpProposalRequest) => Promise<{ ok: boolean; proposalId?: string; message?: string }>;
  confirmOAuthAccess: (request: { clientName: string; redirectUri: string; scopes: string[] }) => Promise<boolean>;
  quickTunnel?: CloudflareQuickTunnel;
  onRemoteOrigin?: (origin: string) => void;
  onStatus?: (status: McpStatusSnapshot) => void;
}

export type McpProposalRequest =
  | { kind: "task_changes"; operations: unknown[] }
  | { kind: "full_agent"; instruction: string }
  | { kind: "productivity_action"; action: unknown };

const defaultPort = 3847;
const localHost = "127.0.0.1";

export class AevumMcpService {
  private settings: McpServiceSettings = { enabled: false, accessMode: "read-only", port: defaultPort, authenticationMode: "bearer", remoteUrl: "", tunnelMode: "persistent" };
  private state: McpServerState = "disabled";
  private message = "";
  private server: Server | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private oauthProvider: AevumOAuthProvider | null = null;
  private oauthDiagnostics: OAuthDiagnostics = { activeSessionCount: 0, registeredClientCount: 0, activeGrantCount: 0 };
  private lastToolListMode: McpAccessMode | undefined;
  private lastToolListScopes: string[] = [];
  private lastToolError = "";
  private readonly quickTunnel: CloudflareQuickTunnel;
  private tunnelStatus: CloudflareTunnelStatus = { state: "disabled" };
  private readonly toolListCache = new Map<McpAccessMode, unknown>();
  private readonly writeReplayCache = new Map<string, { fingerprint: string; expiresAt: number; result: { ok: boolean; proposalId?: string; message?: string } }>();

  constructor(private readonly dependencies: McpServiceDependencies) {
    this.quickTunnel = dependencies.quickTunnel ?? new CloudflareQuickTunnel();
    this.quickTunnel.setStatusListener((status) => {
      this.tunnelStatus = status;
      const shouldOwnOrigin = this.settings.enabled && this.settings.authenticationMode === "oauth" && this.settings.tunnelMode === "temporary";
      if (shouldOwnOrigin && status.state === "running" && status.origin) this.setGeneratedRemoteOrigin(status.origin);
      if (shouldOwnOrigin && (status.state === "error" || status.state === "missing")) this.setGeneratedRemoteOrigin("");
      void this.publishStatus();
    });
  }

  updateSettings(value: unknown): Promise<McpStatusSnapshot> {
    const settings = readMcpSettings(value, this.settings);
    this.settings = settings;
    this.lifecycle = this.lifecycle.then(async () => {
      await this.stopServer();
      const shouldRunTunnel = this.settings.enabled && this.settings.authenticationMode === "oauth" && this.settings.tunnelMode === "temporary";
      if (shouldRunTunnel) this.setGeneratedRemoteOrigin("");
      const tunnel = await this.quickTunnel.reconcile(shouldRunTunnel, this.settings.port);
      if (shouldRunTunnel && tunnel.state === "running" && tunnel.origin) this.setGeneratedRemoteOrigin(tunnel.origin);
      if (this.settings.enabled) await this.startServer();
    });
    return this.lifecycle.then(() => this.getStatus());
  }

  async regenerateToken() {
    const token = this.dependencies.generateToken();
    await this.dependencies.setToken(token);
    if (this.settings.enabled) await this.updateSettings(this.settings);
    return { ok: true, token, status: this.getStatus() };
  }

  async getToken() {
    const token = await this.ensureToken();
    return { ok: true, token };
  }

  async getStatus(): Promise<McpStatusSnapshot> {
    return {
      ...this.settings,
      status: this.state,
      endpoint: endpointFor(this.settings.port),
      remoteEndpoint: remoteMcpEndpoint(this.settings),
      oauth: this.oauthDiagnostics,
      toolAccess: {
        selectedMode: this.settings.accessMode,
        grantedScopes: this.lastToolListScopes.length ? [...this.lastToolListScopes] : this.oauthDiagnostics.lastGrantedScopes ?? [],
        registeredClientCount: this.oauthDiagnostics.registeredClientCount,
        activeGrantCount: this.oauthDiagnostics.activeGrantCount,
        writeToolsExposed: this.lastToolListMode === "full-access",
        lastToolListMode: this.lastToolListMode,
        lastToolError: this.lastToolError || undefined,
      },
      tunnel: this.tunnelStatus,
      hasToken: Boolean(await this.dependencies.getToken()),
      message: this.message || undefined,
    };
  }

  async stop() {
    this.settings = { ...this.settings, enabled: false };
    await this.quickTunnel.stop();
    await this.stopServer();
  }

  async handleRelayRequest(value: unknown, scopes: string[]) {
    const request = isRecord(value) ? value : undefined;
    const id = request && (typeof request.id === "string" || typeof request.id === "number") ? request.id : null;
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return relayRpcError(id, -32600, "Invalid MCP request.");
    if (request.method === "notifications/initialized") return { jsonrpc: "2.0", result: {} };
    const toolMode = resolveToolListMode(this.settings.accessMode, scopes);
    if (request.method === "tools/list" && this.toolListCache.has(toolMode)) {
      this.lastToolListMode = toolMode;
      this.lastToolListScopes = [...scopes];
      return { jsonrpc: "2.0", id, result: this.toolListCache.get(toolMode) };
    }

    const protocolServer = this.createProtocolServer(scopes);
    const client = new Client({ name: "aevum-connect-bridge", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await protocolServer.connect(serverTransport);
      await client.connect(clientTransport);
      const params = isRecord(request.params) ? request.params : {};
      let result: unknown;
      if (request.method === "initialize") {
        result = {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
          capabilities: client.getServerCapabilities() ?? {},
          serverInfo: client.getServerVersion() ?? { name: "aevum-local", version: "1.0.0" },
          instructions: client.getInstructions(),
        };
      } else if (request.method === "ping") result = await client.ping();
      else if (request.method === "tools/list") {
        result = await client.listTools(params);
        this.toolListCache.set(toolMode, result);
        this.lastToolListMode = toolMode;
        this.lastToolListScopes = [...scopes];
      }
      else if (request.method === "tools/call") {
        if (typeof params.name !== "string") return relayRpcError(id, -32602, "Tool name is required.");
        if ("arguments" in params && !isRecord(params.arguments)) return relayRpcError(id, -32602, "Tool arguments must be a JSON object.");
        result = await client.callTool({ name: params.name, arguments: isRecord(params.arguments) ? params.arguments : {} });
      } else if (request.method === "resources/list") result = await client.listResources(params);
      else if (request.method === "resources/read") {
        if (typeof params.uri !== "string") return relayRpcError(id, -32602, "Resource URI is required.");
        result = await client.readResource({ uri: params.uri });
      } else return relayRpcError(id, -32601, "MCP method is not supported by Aevum Connect.");
      return { jsonrpc: "2.0", id, result };
    } catch {
      return relayRpcError(id, -32603, "Aevum could not complete the MCP request.");
    } finally {
      await client.close().catch(() => undefined);
      await protocolServer.close().catch(() => undefined);
    }
  }

  private async startServer() {
    this.state = "starting";
    this.message = "";
    await this.publishStatus();

    try {
      const token = await this.ensureToken();
      const publicBaseUrl = this.settings.authenticationMode === "oauth" ? readRemoteBaseUrl(this.settings.remoteUrl) : undefined;
      if (this.settings.authenticationMode === "oauth" && !publicBaseUrl) throw new Error("INVALID_REMOTE_URL");
      const allowedHosts = [localHost, "localhost", ...(publicBaseUrl ? [publicBaseUrl.hostname] : [])];
      const app = createMcpExpressApp({ host: localHost, allowedHosts });
      app.use((request: Request, response: Response, next: NextFunction) => {
        const rejection = validateRequestLocation(request.headers, request.method, this.settings, publicBaseUrl);
        if (!rejection) {
          if (this.message.startsWith("Tunnel origin mismatch.")) {
            this.message = "";
            void this.publishStatus();
          }
          return next();
        }
        if (rejection.code === "TUNNEL_ORIGIN_MISMATCH") {
          this.message = rejection.message;
          void this.publishStatus();
        }
        response.status(rejection.status).json({
          error: "invalid_request",
          error_description: rejection.message,
        });
      });
      if (publicBaseUrl) {
        this.oauthProvider = new AevumOAuthProvider(
          publicBaseUrl,
          () => allowedOAuthScopes(this.settings.accessMode),
          this.dependencies.confirmOAuthAccess,
          (diagnostics) => {
            this.oauthDiagnostics = diagnostics;
            void this.publishStatus();
          },
        );
        app.use(express.urlencoded({ extended: false }));
        app.get("/.well-known/oauth-protected-resource", (_request: Request, response: Response) => {
          response.json({
            resource: new URL("/mcp", publicBaseUrl).href,
            authorization_servers: [publicBaseUrl.href],
            scopes_supported: allowedOAuthScopes(this.settings.accessMode),
            resource_name: "Aevum MCP",
          });
        });
        app.post("/oauth/decision", async (request: Request, response: Response) => {
          const consentId = typeof request.body?.consent_id === "string" ? request.body.consent_id : "";
          const decision = request.body?.decision === "approve" ? "approve" : "deny";
          await this.oauthProvider?.resolveConsent(consentId, decision, response);
        });
        app.get("/oauth/session/:sessionId/status", (request: Request, response: Response) => {
          const sessionId = typeof request.params.sessionId === "string" ? request.params.sessionId : "";
          response.setHeader("Cache-Control", "no-store");
          response.json(this.oauthProvider?.getAuthorizationStatus(sessionId) ?? { stage: "expired", error: "OAuth is not available." });
        });
        app.use(mcpAuthRouter({
          provider: this.oauthProvider,
          issuerUrl: publicBaseUrl,
          baseUrl: publicBaseUrl,
          resourceServerUrl: new URL("/mcp", publicBaseUrl),
          resourceName: "Aevum MCP",
          scopesSupported: allowedOAuthScopes(this.settings.accessMode),
        }));
      } else {
        this.oauthProvider = null;
      }
      app.use("/mcp", async (request: Request, response: Response, next: NextFunction) => {
        const auth = await authenticateMcpRequest(request.headers, token, this.settings, this.oauthProvider);
        if (auth.ok) {
          response.locals.mcpScopes = auth.scopes;
          return next();
        }
        if (publicBaseUrl) {
          response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", publicBaseUrl).href}", scope="${allowedOAuthScopes(this.settings.accessMode).join(" ")}"`);
        }
        response.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required." }, id: null });
      });
      app.post("/mcp", async (request: Request, response: Response) => {
        const argumentError = normalizeToolCallArguments(request.body);
        if (argumentError) {
          this.lastToolError = argumentError;
          void this.publishStatus();
          response.status(200).json({ jsonrpc: "2.0", error: { code: -32602, message: argumentError }, id: request.body?.id ?? null });
          return;
        }
        const scopes = Array.isArray(response.locals.mcpScopes) ? response.locals.mcpScopes as string[] : [];
        if (request.body?.method === "tools/list") {
          this.lastToolListMode = resolveToolListMode(this.settings.accessMode, scopes);
          this.lastToolListScopes = [...scopes];
          void this.publishStatus();
        }
        const mcpServer = this.createProtocolServer(scopes);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(request, response, request.body);
        } catch {
          if (request.body?.method === "tools/call") {
            this.lastToolError = "MCP tool request failed.";
            void this.publishStatus();
          }
          if (!response.headersSent) {
            response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
          }
        } finally {
          response.on("close", () => {
            void transport.close();
            void mcpServer.close();
          });
        }
      });
      app.get("/mcp", (_request: Request, response: Response) => response.status(405).json(methodNotAllowed()));
      app.delete("/mcp", (_request: Request, response: Response) => response.status(405).json(methodNotAllowed()));

      this.server = await new Promise<Server>((resolve, reject) => {
        const server = app.listen(this.settings.port, localHost, () => resolve(server));
        server.once("error", reject);
      });
      this.state = "running";
    } catch (error) {
      this.server = null;
      this.state = "error";
      this.message = safeServerError(error);
    }
    await this.publishStatus();
  }

  private async stopServer() {
    const server = this.server;
    this.server = null;
    this.oauthProvider = null;
    this.oauthDiagnostics = { activeSessionCount: 0, registeredClientCount: 0, activeGrantCount: 0 };
    this.lastToolListMode = undefined;
    this.lastToolListScopes = [];
    this.lastToolError = "";
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.state = this.settings.enabled ? "starting" : "disabled";
    this.message = "";
    await this.publishStatus();
  }

  private createProtocolServer(scopes: string[]) {
    const server = new McpServer({ name: "aevum-local", version: "1.0.0" });
    const resource = (name: string, uri: string, description: string, select: (snapshot: SafeSnapshot) => Record<string, unknown>) => {
      server.registerResource(name, uri, { description, mimeType: "application/json" }, async () => {
        const snapshot = sanitizeSnapshot(await this.dependencies.requestSnapshot());
        return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(select(snapshot)) }] };
      });
    };

    resource("today-tasks", "aevum://tasks/today", "Active tasks scheduled today or overdue.", (snapshot) => taskCollection(todayTasks(snapshot.tasks)));
    resource("upcoming-tasks", "aevum://tasks/upcoming", "Active tasks scheduled after today.", (snapshot) => taskCollection(upcomingTasks(snapshot.tasks)));
    resource("all-tasks", "aevum://tasks/all", "Up to 100 sanitized Aevum tasks. Use search_tasks to find a specific task.", (snapshot) => taskCollection(snapshot.tasks, 100));
    resource("categories", "aevum://categories", "Sanitized Aevum categories.", (snapshot) => ({ categories: snapshot.categories, count: snapshot.categories.length }));
    resource("recent-activity", "aevum://activity/recent", "Recent confirmed action summaries.", (snapshot) => ({ activity: snapshot.activity, count: snapshot.activity.length }));
    resource("app-status", "aevum://app/status", "Safe Aevum integration status.", (snapshot) => ({ ...snapshot.app, mcpAccessMode: this.settings.accessMode }));

    registerJsonTool(server, "get_today_tasks", "List a compact page of active tasks due today or overdue. Use search_tasks when the user identifies a task by words.", {
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).max(10_000).optional(),
    }, async ({ limit = 20, offset = 0 }) => taskCollection(todayTasks((await this.snapshot()).tasks), limit, offset));
    registerJsonTool(server, "get_upcoming_tasks", "List a compact page of active future tasks. Use search_tasks before changing a task.", {
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).max(10_000).optional(),
    }, async ({ limit = 20, offset = 0 }) => taskCollection(upcomingTasks((await this.snapshot()).tasks), limit, offset));
    registerJsonTool(server, "search_tasks", "Find tasks by title, short description, or tag before reading or changing them. Returns compact task identities and never guesses among matches.", {
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).max(10_000).optional(),
    }, async ({ query, limit = 20, offset = 0 }) => {
      const normalized = query.toLocaleLowerCase();
      const snapshot = await this.snapshot();
      const tasks = snapshot.tasks.filter((task) =>
        [task.title, task.description, ...task.tags].some((value) => value.toLocaleLowerCase().includes(normalized)),
      );
      return { query, ...taskCollection(tasks, limit, offset, snapshot.categories) };
    });
    registerJsonTool(server, "get_task_details", "Get one task by its exact user-facing ID after search_tasks identifies it.", {
      taskId: z.string().trim().min(1).max(200),
    }, async ({ taskId }) => {
      const task = (await this.snapshot()).tasks.find((item) => item.id === taskId);
      return task ? { task, found: true } : { taskId, found: false, error: "Task not found. Search again before changing anything." };
    });
    registerJsonTool(server, "get_categories", "Get sanitized categories.", {}, async () => {
      const categories = (await this.snapshot()).categories;
      return { categories, count: categories.length };
    });
    registerJsonTool(server, "get_recent_activity", "Get recent confirmed action summaries.", {
      limit: z.number().int().min(1).max(50).optional(),
    }, async ({ limit = 20 }) => {
      const activity = (await this.snapshot()).activity.slice(0, limit);
      return { activity, count: activity.length };
    });

    const reminderMinutesSchema = z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(30), z.literal(60)]).nullable().optional();
    const weekdayNameSchema = z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
    const repeatSchema = z.strictObject({
      enabled: z.boolean(),
      type: z.enum(["daily", "weekly", "monthly", "custom"]).optional(),
      frequency: z.enum(["daily", "weekly", "monthly", "custom"]).optional(),
      interval: z.number().int().min(1).max(365).optional(),
      unit: z.enum(["day", "week", "month"]).optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      daysOfWeek: z.array(weekdayNameSchema).max(7).optional(),
      excludedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    }).optional();
    const subtaskDraftSchema = z.strictObject({
      title: z.string().trim().min(1).max(500),
      completed: z.boolean().optional(),
    });
    const subtaskUpdateSchema = z.strictObject({
      id: z.string().trim().min(1).max(200).optional(),
      title: z.string().trim().min(1).max(500),
      completed: z.boolean().optional(),
    });
    const taskDraftSchema = z.strictObject({
      title: z.string().trim().min(1).max(500),
      description: z.string().max(10_000).optional(),
      scheduledAt: z.string().max(40).nullable().optional(),
      durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      reminderMinutes: reminderMinutesSchema,
      repeat: repeatSchema,
      projectName: z.string().trim().min(1).max(200).optional(),
      categoryId: z.string().trim().min(1).max(200).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      subtasks: z.array(subtaskDraftSchema).max(50).optional(),
    });
    const editableTaskFields = {
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(10_000).optional(),
      scheduledAt: z.string().max(40).nullable().optional(),
      durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      reminderMinutes: reminderMinutesSchema,
      repeat: repeatSchema,
      projectId: z.string().trim().min(1).max(200).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      subtasks: z.array(subtaskUpdateSchema).max(50).optional(),
    };
    const reminderSchema = z.strictObject({
      enabled: z.boolean().optional(),
      relativeMinutesBefore: reminderMinutesSchema,
      exactAt: z.string().max(40).optional(),
    });
    const idempotencyKeySchema = z.string().trim().min(8).max(200).optional().describe("Stable unique key for safely retrying the same write request.");

    if (this.settings.accessMode !== "read-only" && scopes.includes("mcp:propose")) {
      const changesSchema = z.object(editableTaskFields);
      const operationSchema = z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("update"), taskId: z.string().min(1).max(200), changes: changesSchema, reason: z.string().max(1000).optional() }),
        z.object({ operation: z.literal("set_status"), taskId: z.string().min(1).max(200), status: z.enum(["active", "completed"]), reason: z.string().max(1000).optional() }),
        z.object({ operation: z.literal("delete"), taskId: z.string().min(1).max(200), reason: z.string().max(1000).optional() }),
      ]);
      registerJsonTool(server, "propose_task_changes", "Send task changes to Aevum for confirmation. Nothing is changed immediately.", {
        operations: z.array(operationSchema).min(1).max(100),
      }, async ({ operations }) => proposalResponse(await this.dependencies.requestProposal({ kind: "task_changes", operations })));
      registerJsonTool(server, "start_full_agent_workflow", "Ask Aevum Full Agent to prepare an in-app proposal for confirmation.", {
        instruction: z.string().trim().min(1).max(10_000),
      }, async ({ instruction }) => proposalResponse(await this.dependencies.requestProposal({ kind: "full_agent", instruction })));
    }

    if (this.settings.accessMode === "full-access" && scopes.includes("mcp:write")) {
      const submitAction = (action: unknown, idempotencyKey?: string) => this.submitReplaySafeAction(action, idempotencyKey).then(proposalResponse);
      const submitTaskUpdate = (taskId: string, changes: Record<string, unknown>, idempotencyKey?: string) =>
        submitAction({ type: "manage_tasks", operations: [{ operation: "update", taskId, changes: normalizeMcpTaskChanges(changes) }] }, idempotencyKey);

      registerJsonTool(server, "create_task", "Create one task with date/time, category, recurrence, reminder offset, tags, and subtasks. The write is sent to Aevum for confirmation.", {
        task: taskDraftSchema,
        idempotencyKey: idempotencyKeySchema,
      }, async ({ task, idempotencyKey }) => submitAction({ type: "create_tasks", tasks: [normalizeMcpTaskDraft(task)] }, idempotencyKey));
      registerJsonTool(server, "create_tasks", "Create one or more tasks. Each task supports the same fields as create_task.", {
        tasks: z.array(taskDraftSchema).min(1).max(100),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ tasks, idempotencyKey }) => submitAction({ type: "create_tasks", tasks: tasks.map(normalizeMcpTaskDraft) }, idempotencyKey));
      registerJsonTool(server, "update_task", "Partially edit any safe task field after confirmation in Aevum.", {
        taskId: z.string().trim().min(1).max(200),
        changes: z.strictObject(editableTaskFields).refine((changes) => Object.keys(changes).length > 0),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, changes, idempotencyKey }) => submitTaskUpdate(taskId, changes, idempotencyKey));
      registerJsonTool(server, "reschedule_task", "Move or reschedule a task after confirmation in Aevum.", {
        taskId: z.string().trim().min(1).max(200),
        scheduledAt: z.string().max(40).nullable(),
        durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, scheduledAt, durationMinutes, idempotencyKey }) => submitTaskUpdate(taskId, { scheduledAt, ...(durationMinutes === undefined ? {} : { durationMinutes }) }, idempotencyKey));
      registerJsonTool(server, "set_task_status", "Complete or reopen a task after confirmation in Aevum.", {
        taskId: z.string().trim().min(1).max(200),
        status: z.enum(["active", "completed"]),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, status, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: [{ operation: "set_status", taskId, status }] }, idempotencyKey));
      registerJsonTool(server, "complete_task", "Mark one exact task ID complete. Completing a recurring task uses Aevum's existing next-occurrence logic.", {
        taskId: z.string().trim().min(1).max(200),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: [{ operation: "set_status", taskId, status: "completed" }] }, idempotencyKey));
      registerJsonTool(server, "reopen_task", "Reopen one exact completed task ID.", {
        taskId: z.string().trim().min(1).max(200),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: [{ operation: "set_status", taskId, status: "active" }] }, idempotencyKey));
      registerJsonTool(server, "delete_task", "Delete a task after confirmation in Aevum.", {
        taskId: z.string().trim().min(1).max(200),
        recurrenceScope: z.enum(["this_occurrence", "future_occurrences", "entire_series"]).optional(),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, recurrenceScope = "this_occurrence", idempotencyKey }) => {
        const operations = recurrenceScope === "this_occurrence"
          ? [{ operation: "delete", taskId }]
          : buildRecurringDeleteOperations((await this.snapshot()).tasks, taskId, recurrenceScope);
        if (!operations.length) return { status: "unsupported", message: "No recurring occurrences could be identified for that task id." };
        if (operations.length > 100) return { status: "unsupported", message: "Recurring delete is limited to 100 visible occurrences per request.", count: operations.length };
        return submitAction({ type: "manage_tasks", operations }, idempotencyKey);
      });
      registerJsonTool(server, "list_task_reminders", "Return the reminder state for one exact task ID.", {
        taskId: z.string().trim().min(1).max(200),
      }, async ({ taskId }) => {
        const task = (await this.snapshot()).tasks.find((item) => item.id === taskId);
        if (!task) return { status: "not_found", taskId, reminders: [], count: 0 };
        const reminders = task.reminderMinutes === null ? [] : [{ type: "relative", relativeMinutesBefore: task.reminderMinutes, enabled: true }];
        return { status: "ok", taskId, reminders, count: reminders.length, limitation: "Aevum currently stores one relative reminder offset per task." };
      });
      registerJsonTool(server, "set_task_reminder", "Add or edit a task reminder. Aevum currently supports one relative reminder offset: 0, 5, 10, 30, or 60 minutes before the scheduled time.", {
        taskId: z.string().trim().min(1).max(200),
        reminder: reminderSchema,
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, reminder, idempotencyKey }) => {
        const parsed = normalizeMcpReminder(reminder);
        if (!parsed.ok) return parsed.result;
        return submitTaskUpdate(taskId, { reminderMinutes: parsed.reminderMinutes }, idempotencyKey);
      });
      registerJsonTool(server, "remove_task_reminder", "Remove the reminder from one exact task ID.", {
        taskId: z.string().trim().min(1).max(200),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, idempotencyKey }) => submitTaskUpdate(taskId, { reminderMinutes: null }, idempotencyKey));
      registerJsonTool(server, "list_categories", "List sanitized categories with ids, names, colors, and descriptions.", {}, async () => {
        const categories = (await this.snapshot()).categories;
        return { categories, count: categories.length };
      });
      registerJsonTool(server, "assign_task_to_category", "Assign a task to a category after confirmation in Aevum.", {
        taskId: z.string().trim().min(1).max(200),
        categoryId: z.string().trim().min(1).max(200),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskId, categoryId, idempotencyKey }) => submitTaskUpdate(taskId, { projectId: categoryId }, idempotencyKey));
      registerJsonTool(server, "create_category", "Create a task category after confirmation in Aevum.", {
        name: z.string().trim().min(1).max(200),
        color: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(1000).optional(),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ name, color, description, idempotencyKey }) => submitAction({
        type: "batch_action",
        categoriesToCreate: [{ ref: "mcp-category", name, ...(color ? { color } : {}), ...(description ? { description } : {}) }],
      }, idempotencyKey));
      registerJsonTool(server, "update_category", "Rename or edit category color/description after confirmation in Aevum.", {
        categoryId: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200).optional(),
        color: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(1000).optional(),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ categoryId, name, color, description, idempotencyKey }) => submitAction({ type: "batch_action", categoriesToUpdate: [{ categoryId, ...(name ? { name } : {}), ...(color ? { color } : {}), ...(description === undefined ? {} : { description }) }] }, idempotencyKey));
      registerJsonTool(server, "rename_category", "Rename a task category after confirmation in Aevum.", {
        categoryId: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ categoryId, name, idempotencyKey }) => submitAction({ type: "batch_action", categoriesToRename: [{ categoryId, newName: name }] }, idempotencyKey));
      registerJsonTool(server, "delete_category", "Delete a category by exact id using an explicit task handling strategy. Deleting tasks too is always confirmation/proposal based.", {
        categoryId: z.string().trim().min(1).max(200),
        strategy: z.discriminatedUnion("mode", [
          z.strictObject({ mode: z.literal("move_tasks_to_uncategorized") }),
          z.strictObject({ mode: z.literal("move_tasks_to_category"), targetCategoryId: z.string().trim().min(1).max(200) }),
          z.strictObject({ mode: z.literal("delete_tasks_too"), confirmTaskDeletion: z.literal(true) }),
        ]),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ categoryId, strategy, idempotencyKey }) => submitAction({ type: "batch_action", categoriesToDelete: [{ categoryId, strategy }] }, idempotencyKey));
      registerJsonTool(server, "move_tasks_between_categories", "Move explicit task IDs from one category to another after confirmation in Aevum.", {
        taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
        targetCategoryId: z.string().trim().min(1).max(200),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskIds, targetCategoryId, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: uniqueStrings(taskIds).map((taskId) => ({ operation: "update", taskId, changes: { projectId: targetCategoryId } })) }, idempotencyKey));
      registerJsonTool(server, "bulk_update_tasks", "Update explicit task IDs with the same safe partial changes. Requires exact task ids.", {
        taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
        changes: z.strictObject(editableTaskFields).refine((changes) => Object.keys(changes).length > 0),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskIds, changes, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: uniqueStrings(taskIds).map((taskId) => ({ operation: "update", taskId, changes: normalizeMcpTaskChanges(changes) })) }, idempotencyKey));
      registerJsonTool(server, "bulk_reschedule_tasks", "Reschedule explicit task IDs to the same date/time or date-only value.", {
        taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
        scheduledAt: z.string().max(40).nullable(),
        durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskIds, scheduledAt, durationMinutes, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: uniqueStrings(taskIds).map((taskId) => ({ operation: "update", taskId, changes: { scheduledAt, ...(durationMinutes === undefined ? {} : { durationMinutes }) } })) }, idempotencyKey));
      registerJsonTool(server, "bulk_complete_tasks", "Complete explicit task IDs after confirmation in Aevum.", {
        taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskIds, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: uniqueStrings(taskIds).map((taskId) => ({ operation: "set_status", taskId, status: "completed" })) }, idempotencyKey));
      registerJsonTool(server, "bulk_delete_tasks", "Delete explicit task IDs only. Vague destructive matching is intentionally unsupported.", {
        taskIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
        idempotencyKey: idempotencyKeySchema,
      }, async ({ taskIds, idempotencyKey }) => submitAction({ type: "manage_tasks", operations: uniqueStrings(taskIds).map((taskId) => ({ operation: "delete", taskId })) }, idempotencyKey));
    }
    return server;
  }

  private async snapshot() {
    return sanitizeSnapshot(await this.dependencies.requestSnapshot());
  }

  private async submitReplaySafeAction(action: unknown, idempotencyKey?: string) {
    if (!idempotencyKey) return this.dependencies.requestProposal({ kind: "productivity_action", action });
    const now = Date.now();
    for (const [key, entry] of this.writeReplayCache) if (entry.expiresAt <= now) this.writeReplayCache.delete(key);
    const fingerprint = createHash("sha256").update(JSON.stringify(action)).digest("base64url");
    const existing = this.writeReplayCache.get(idempotencyKey);
    if (existing) return existing.fingerprint === fingerprint ? existing.result : { ok: false, message: "This idempotency key was already used for a different write." };
    const result = await this.dependencies.requestProposal({ kind: "productivity_action", action });
    this.writeReplayCache.set(idempotencyKey, { fingerprint, expiresAt: now + 10 * 60_000, result });
    if (this.writeReplayCache.size > 500) this.writeReplayCache.delete(this.writeReplayCache.keys().next().value!);
    return result;
  }

  private async ensureToken() {
    const existing = await this.dependencies.getToken();
    if (existing) return existing;
    const token = this.dependencies.generateToken();
    await this.dependencies.setToken(token);
    return token;
  }

  private async publishStatus() {
    this.dependencies.onStatus?.(await this.getStatus());
  }

  private setGeneratedRemoteOrigin(origin: string) {
    if (this.settings.remoteUrl === origin) return;
    this.settings = { ...this.settings, remoteUrl: origin };
    this.dependencies.onRemoteOrigin?.(origin);
  }
}

export function validateLocalMcpRequest(headers: Record<string, string | string[] | undefined>, token: string, port: number) {
  const settings: McpServiceSettings = { enabled: true, accessMode: "read-only", port, authenticationMode: "bearer", remoteUrl: "", tunnelMode: "persistent" };
  return validateRequestLocation(headers, "POST", settings) ?? validateStaticBearer(headers, token, port);
}

export function readMcpSettings(value: unknown, fallback: McpServiceSettings = { enabled: false, accessMode: "read-only", port: defaultPort, authenticationMode: "bearer", remoteUrl: "", tunnelMode: "persistent" }): McpServiceSettings {
  if (!isRecord(value)) return fallback;
  return {
    enabled: value.enabled === true,
    accessMode: value.accessMode === "full-access" ? "full-access" : value.accessMode === "proposals" ? "proposals" : "read-only",
    port: readPort(value.port, fallback.port),
    authenticationMode: value.authenticationMode === "oauth" ? "oauth" : "bearer",
    remoteUrl: typeof value.remoteUrl === "string" ? normalizeRemoteUrl(value.remoteUrl) : fallback.remoteUrl,
    tunnelMode: value.tunnelMode === "temporary" || value.tunnelMode === "persistent"
      ? value.tunnelMode
      : value.autoTunnel === true ? "temporary" : "persistent",
  };
}

function registerJsonTool(server: McpServer, name: string, description: string, inputSchema: Record<string, z.ZodType>, handler: (input: any) => Promise<Record<string, unknown>>) {
  server.registerTool(name, { description, inputSchema: z.strictObject(inputSchema) }, async (input: any) => {
    const result = await handler(input);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
}

function proposalResponse(result: { ok: boolean; proposalId?: string; message?: string }) {
  if (!result.ok) return { status: "error", message: result.message ?? "Aevum could not create the proposal." };
  return { proposalId: result.proposalId ?? "", status: "awaiting_confirmation", message: "Proposal sent to Aevum for user confirmation. No changes have been applied." };
}

function normalizeMcpTaskDraft(task: Record<string, unknown>) {
  const { categoryId, repeat, ...rest } = task;
  return {
    ...rest,
    ...(typeof categoryId === "string" && categoryId.trim() ? { categoryTarget: { kind: "existing", categoryId: categoryId.trim() } } : {}),
    ...(repeat ? { repeat: normalizeMcpRepeat(repeat) } : {}),
  };
}

function normalizeMcpTaskChanges(changes: Record<string, unknown>) {
  return {
    ...changes,
    ...(changes.repeat ? { repeat: normalizeMcpRepeat(changes.repeat) } : {}),
  };
}

function normalizeMcpRepeat(value: unknown) {
  if (!isRecord(value)) return value;
  const frequency = value.frequency === "daily" || value.frequency === "weekly" || value.frequency === "monthly" || value.frequency === "custom"
    ? value.frequency
    : undefined;
  return {
    enabled: value.enabled === true,
    type: value.type ?? frequency ?? "daily",
    interval: value.interval,
    unit: value.unit,
    weekdays: Array.isArray(value.weekdays) ? value.weekdays : weekdayNamesToNumbers(value.daysOfWeek),
    excludedWeekdays: value.excludedWeekdays,
  };
}

function normalizeMcpReminder(value: Record<string, unknown>): { ok: true; reminderMinutes: number | null } | { ok: false; result: Record<string, unknown> } {
  if (typeof value.exactAt === "string" && value.exactAt.trim()) {
    return {
      ok: false,
      result: {
        status: "unsupported",
        message: "Aevum currently supports one relative reminder offset per task, not a separate exact reminder datetime.",
        limitation: "Set scheduledAt to the desired time and use relativeMinutesBefore 0, 5, 10, 30, or 60.",
      },
    };
  }
  if (value.enabled === false || value.relativeMinutesBefore === null) return { ok: true, reminderMinutes: null };
  if (value.relativeMinutesBefore === 0 || value.relativeMinutesBefore === 5 || value.relativeMinutesBefore === 10 || value.relativeMinutesBefore === 30 || value.relativeMinutesBefore === 60) {
    return { ok: true, reminderMinutes: value.relativeMinutesBefore };
  }
  return {
    ok: false,
    result: {
      status: "invalid",
      message: "Reminder offset must be 0, 5, 10, 30, or 60 minutes.",
    },
  };
}

function buildRecurringDeleteOperations(tasks: SafeTask[], taskId: string, scope: "future_occurrences" | "entire_series") {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return [];
  const rootId = task.recurringParentId ?? task.id;
  const series = tasks.filter((item) => (item.recurringParentId ?? item.id) === rootId);
  const selectedAt = task.scheduledAt;
  return series
    .filter((item) => scope === "entire_series" || (selectedAt ? (item.scheduledAt ?? "") >= selectedAt : item.id === taskId))
    .map((item) => ({ operation: "delete", taskId: item.id }));
}

function weekdayNamesToNumbers(value: unknown) {
  if (!Array.isArray(value)) return [];
  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return [...new Set(value.map((day) => typeof day === "string" ? dayMap[day] : undefined).filter((day): day is number => typeof day === "number"))];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function taskCollection(tasks: SafeTask[], limit = 20, offset = 0, categories: SafeSnapshot["categories"] = []) {
  const page = tasks.slice(offset, offset + limit).map((task) => compactTask(task, categories));
  return { tasks: page, count: page.length, total: tasks.length, offset, limit, hasMore: offset + page.length < tasks.length };
}

function compactTask(task: SafeTask, categories: SafeSnapshot["categories"]) {
  const category = categories.find((item) => item.id === task.projectId);
  return {
    id: task.id,
    title: task.title,
    scheduledAt: task.scheduledAt,
    durationMinutes: task.durationMinutes,
    status: task.status,
    category: category ? { id: category.id, name: category.name } : { id: task.projectId },
    recurrence: task.repeat.enabled ? {
      enabled: true,
      type: task.repeat.type,
      interval: task.repeat.interval,
      unit: task.repeat.unit,
      weekdays: task.repeat.weekdays,
      excludedWeekdays: task.repeat.excludedWeekdays,
      nextRepeatAt: task.nextRepeatAt,
    } : { enabled: false },
    reminder: task.reminderMinutes === null ? { enabled: false } : { enabled: true, relativeMinutesBefore: task.reminderMinutes },
    tags: task.tags,
    subtasks: task.subtasks,
    description: task.description.length > 280 ? `${task.description.slice(0, 277)}...` : task.description,
  };
}

type SafeTask = {
  id: string; title: string; description: string; status: "active" | "completed"; scheduledAt: string | null;
  projectId: string; durationMinutes: number | null; reminderMinutes: number | null; tags: string[];
  repeat: { enabled: boolean; type: "daily" | "weekly" | "monthly" | "custom"; interval: number; unit: "day" | "week" | "month"; weekdays: number[]; excludedWeekdays: number[] };
  nextRepeatAt: string | null; recurringParentId?: string;
  subtasks: Array<{ id: string; title: string; completed: boolean }>;
};
type SafeSnapshot = {
  tasks: SafeTask[];
  categories: Array<{ id: string; name: string; color: string; description: string }>;
  activity: Array<{ transactionId: string; source: string; actionKind: string; appliedAt: string; status: string; summary: Record<string, unknown> }>;
  app: { ready: boolean; version?: string; language?: string };
};

export function sanitizeSnapshot(value: unknown): SafeSnapshot {
  if (!isRecord(value)) throw new Error("Aevum renderer is not ready.");
  return {
    tasks: Array.isArray(value.tasks) ? value.tasks.map(sanitizeTask).filter((task): task is SafeTask => Boolean(task)) : [],
    categories: Array.isArray(value.categories) ? value.categories.map(sanitizeCategory).filter((category): category is SafeSnapshot["categories"][number] => Boolean(category)) : [],
    activity: Array.isArray(value.activity) ? value.activity.slice(0, 50).map(sanitizeActivity).filter((entry): entry is SafeSnapshot["activity"][number] => Boolean(entry)) : [],
    app: isRecord(value.app) ? {
      ready: value.app.ready === true,
      version: typeof value.app.version === "string" ? value.app.version : undefined,
      language: value.app.language === "ru" ? "ru" : "en",
    } : { ready: false },
  };
}

function sanitizeTask(value: unknown): SafeTask | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return undefined;
  return {
    id: value.id,
    title: value.title,
    description: typeof value.description === "string" ? value.description : "",
    status: value.status === "completed" ? "completed" : "active",
    scheduledAt: typeof value.scheduledAt === "string" ? value.scheduledAt : null,
    projectId: typeof value.projectId === "string" ? value.projectId : "uncategorized",
    durationMinutes: typeof value.durationMinutes === "number" ? value.durationMinutes : null,
    reminderMinutes: typeof value.reminderMinutes === "number" ? value.reminderMinutes : null,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 100) : [],
    repeat: sanitizeRepeat(value.repeat),
    nextRepeatAt: typeof value.nextRepeatAt === "string" ? value.nextRepeatAt : null,
    recurringParentId: typeof value.recurringParentId === "string" ? value.recurringParentId : undefined,
    subtasks: Array.isArray(value.subtasks) ? value.subtasks.map((subtask) => isRecord(subtask) && typeof subtask.id === "string" && typeof subtask.title === "string" ? { id: subtask.id, title: subtask.title, completed: subtask.completed === true } : undefined).filter((subtask): subtask is SafeTask["subtasks"][number] => Boolean(subtask)) : [],
  };
}

function sanitizeRepeat(value: unknown): SafeTask["repeat"] {
  if (!isRecord(value)) return { enabled: false, type: "daily", interval: 1, unit: "day", weekdays: [], excludedWeekdays: [] };
  const type = value.type === "weekly" || value.type === "monthly" || value.type === "custom" ? value.type : "daily";
  const unit = value.unit === "week" || value.unit === "month" ? value.unit : "day";
  return {
    enabled: value.enabled === true,
    type,
    interval: typeof value.interval === "number" && Number.isFinite(value.interval) && value.interval > 0 ? Math.floor(value.interval) : 1,
    unit,
    weekdays: readWeekdayNumbers(value.weekdays),
    excludedWeekdays: readWeekdayNumbers(value.excludedWeekdays),
  };
}

function readWeekdayNumbers(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))];
}

function sanitizeCategory(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  return { id: value.id, name: value.name, color: typeof value.color === "string" ? value.color : "", description: typeof value.description === "string" ? value.description : "" };
}

function sanitizeActivity(value: unknown) {
  if (!isRecord(value) || typeof value.transactionId !== "string") return undefined;
  return {
    transactionId: value.transactionId,
    source: value.source === "telegram" || value.source === "mcp" ? value.source : "assistant",
    actionKind: typeof value.actionKind === "string" ? value.actionKind : "manage",
    appliedAt: typeof value.appliedAt === "string" ? value.appliedAt : "",
    status: typeof value.status === "string" ? value.status : "applied",
    summary: sanitizeSummary(value.summary),
  };
}

function sanitizeSummary(value: unknown) {
  if (!isRecord(value)) return {};
  const allowed = ["kind", "taskTitles", "taskCount", "projectNames", "createdTaskCount", "updatedTaskCount", "deletedTaskCount", "completedTaskCount", "reopenedTaskCount", "destructive"];
  return Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, value[key]]));
}

function todayTasks(tasks: SafeTask[]) {
  const today = localDate(new Date());
  return tasks.filter((task) => task.status === "active" && Boolean(task.scheduledAt) && task.scheduledAt!.slice(0, 10) <= today);
}

function upcomingTasks(tasks: SafeTask[]) {
  const today = localDate(new Date());
  return tasks.filter((task) => task.status === "active" && Boolean(task.scheduledAt) && task.scheduledAt!.slice(0, 10) > today);
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function safeTokenEqual(candidate: string, expected: string) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

async function authenticateMcpRequest(
  headers: Record<string, string | string[] | undefined>,
  staticToken: string,
  settings: McpServiceSettings,
  oauthProvider: AevumOAuthProvider | null,
): Promise<{ ok: true; scopes: string[] } | { ok: false }> {
  const authorization = firstHeader(headers.authorization);
  if (!authorization?.startsWith("Bearer ")) return { ok: false };
  const token = authorization.slice(7);
  const host = firstHeader(headers.host);
  const isLocalRequest = host === `${localHost}:${settings.port}` || host === `localhost:${settings.port}`;
  if (isLocalRequest && safeTokenEqual(token, staticToken)) {
    return { ok: true, scopes: allowedOAuthScopes(settings.accessMode) };
  }
  if (!oauthProvider || settings.authenticationMode !== "oauth") return { ok: false };
  try {
    const info = await oauthProvider.verifyAccessToken(token);
    if (!info.scopes.includes("mcp:read")) return { ok: false };
    return { ok: true, scopes: info.scopes };
  } catch {
    return { ok: false };
  }
}

export function validateRequestLocation(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  settings: McpServiceSettings,
  publicBaseUrl = readRemoteBaseUrl(settings.remoteUrl),
) {
  const host = normalizeAuthority(firstHeader(headers.host));
  const localHosts = new Set([`${localHost}:${settings.port}`, `localhost:${settings.port}`]);
  if (settings.authenticationMode !== "oauth" || !publicBaseUrl) {
    if (!host || !localHosts.has(host)) return { status: 403, code: "INVALID_HOST", message: "Invalid host." };
    const origin = firstHeader(headers.origin);
    const allowedOrigins = new Set([`http://${localHost}:${settings.port}`, `http://localhost:${settings.port}`]);
    if (origin && !allowedOrigins.has(origin)) return { status: 403, code: "INVALID_ORIGIN", message: "Invalid origin." };
    return null;
  }

  const remoteHost = publicBaseUrl.host.toLocaleLowerCase();
  const forwardedHost = normalizeAuthority(firstForwardedHeader(headers["x-forwarded-host"]));
  const forwardedProto = firstForwardedHeader(headers["x-forwarded-proto"])?.toLocaleLowerCase();
  const hostIsLocal = Boolean(host && localHosts.has(host));
  const hostIsRemote = host === remoteHost;
  const forwardedRouteMatches = hostIsLocal && forwardedHost === remoteHost && forwardedProto === "https";
  const preservedHostRouteMatches = hostIsRemote
    && (!forwardedHost || forwardedHost === remoteHost)
    && (!forwardedProto || forwardedProto === "https");
  const hasForwardedAuthority = Boolean(forwardedHost || forwardedProto);
  if ((hostIsLocal && hasForwardedAuthority && !forwardedRouteMatches) || (!hostIsLocal && !preservedHostRouteMatches)) {
    return tunnelOriginMismatch(publicBaseUrl, effectiveIncomingOrigin(host, forwardedHost, forwardedProto));
  }

  const rawOrigin = firstHeader(headers.origin);
  const origin = normalizeOrigin(rawOrigin);
  const allowedOrigins = new Set([`http://${localHost}:${settings.port}`, `http://localhost:${settings.port}`]);
  allowedOrigins.add(publicBaseUrl.origin);
  if (rawOrigin && rawOrigin !== "null" && !origin) return tunnelOriginMismatch(publicBaseUrl, rawOrigin);
  if (origin && !allowedOrigins.has(origin)) return tunnelOriginMismatch(publicBaseUrl, origin);

  const isSafeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (!isSafeMethod && !origin) {
    const rawReferer = firstHeader(headers.referer);
    const refererOrigin = normalizeUrlOrigin(rawReferer);
    if (rawReferer && !refererOrigin) return tunnelOriginMismatch(publicBaseUrl, rawReferer);
    if (refererOrigin && !allowedOrigins.has(refererOrigin)) return tunnelOriginMismatch(publicBaseUrl, refererOrigin);
  }
  return null;
}

function tunnelOriginMismatch(publicBaseUrl: URL, received?: string) {
  const suffix = received ? ` Incoming origin: ${received}.` : "";
  return {
    status: 403,
    code: "TUNNEL_ORIGIN_MISMATCH",
    message: `Tunnel origin mismatch. Expected ${publicBaseUrl.origin}.${suffix} Update the MCP remote origin in Settings if the tunnel URL changed, then connect using <origin>/mcp.`,
  };
}

function effectiveIncomingOrigin(host: string | undefined, forwardedHost: string | undefined, forwardedProto: string | undefined) {
  const authority = forwardedHost ?? host;
  const protocol = forwardedProto ?? (authority?.startsWith("127.0.0.1") || authority?.startsWith("localhost") ? "http" : "https");
  return authority ? `${protocol}://${authority}` : undefined;
}

function normalizeAuthority(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase();
  if (!normalized || /[\s/@\\]/.test(normalized)) return undefined;
  return normalized;
}

function normalizeOrigin(value: string | undefined) {
  if (!value || value === "null") return undefined;
  return normalizeUrlOrigin(value);
}

function normalizeUrlOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function firstForwardedHeader(value: string | string[] | undefined) {
  return firstHeader(value)?.split(",", 1)[0]?.trim();
}

function validateStaticBearer(headers: Record<string, string | string[] | undefined>, token: string, port: number) {
  const authorization = firstHeader(headers.authorization);
  const host = firstHeader(headers.host);
  const isLocal = host === `${localHost}:${port}` || host === `localhost:${port}`;
  if (!isLocal || !authorization?.startsWith("Bearer ") || !safeTokenEqual(authorization.slice(7), token)) {
    return { status: 401, message: "Authentication required." };
  }
  return null;
}

function allowedOAuthScopes(accessMode: McpAccessMode) {
  if (accessMode === "full-access") return ["mcp:read", "mcp:propose", "mcp:write"];
  return accessMode === "proposals" ? ["mcp:read", "mcp:propose"] : ["mcp:read"];
}

function resolveToolListMode(configuredMode: McpAccessMode, scopes: string[]): McpAccessMode {
  if (configuredMode === "full-access" && scopes.includes("mcp:write")) return "full-access";
  if (configuredMode !== "read-only" && scopes.includes("mcp:propose")) return "proposals";
  return "read-only";
}

export function readRemoteBaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    url.pathname = "/";
    return url;
  } catch {
    return undefined;
  }
}

function normalizeRemoteUrl(value: string) {
  const url = readRemoteBaseUrl(value.trim());
  return url ? url.origin : value.trim();
}

function readPort(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : fallback;
}

function endpointFor(port: number) {
  return `http://${localHost}:${port}/mcp`;
}

function remoteMcpEndpoint(settings: McpServiceSettings) {
  if (settings.authenticationMode !== "oauth") return undefined;
  const base = readRemoteBaseUrl(settings.remoteUrl);
  return base ? new URL("/mcp", base).href : undefined;
}

function safeServerError(error: unknown) {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "EADDRINUSE") return "The selected port is already in use.";
  if (code === "EACCES") return "Aevum cannot bind to the selected port.";
  if (isRecord(error) && error.message === "INVALID_REMOTE_URL") return "OAuth requires a valid HTTPS tunnel URL.";
  return "The local MCP server could not start.";
}

function methodNotAllowed() {
  return { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null };
}

function relayRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function normalizeToolCallArguments(body: unknown): string | undefined {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return undefined;
  if (!("arguments" in body.params) || body.params.arguments === undefined) {
    body.params.arguments = {};
    return undefined;
  }
  if (!isRecord(body.params.arguments)) return "Tool arguments must be a JSON object.";
  return undefined;
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AevumMcpService, readMcpSettings, validateLocalMcpRequest, validateRequestLocation, type McpProposalRequest } from "./mcpService";
import { CloudflareQuickTunnel } from "./cloudflareQuickTunnel";

describe.sequential("Aevum local MCP service", () => {
  const activeServices: AevumMcpService[] = [];

  afterEach(async () => {
    await Promise.all(activeServices.splice(0).map((service) => service.stop()));
  });

  it("defaults to disabled read-only localhost settings", () => {
    expect(readMcpSettings(undefined)).toEqual({
      enabled: false,
      accessMode: "read-only",
      port: 3847,
      authenticationMode: "bearer",
      remoteUrl: "",
      tunnelMode: "persistent",
    });
  });

  it("requires the correct token and rejects non-local host or origin", () => {
    const valid = { host: "127.0.0.1:3847", authorization: "Bearer secret" };
    expect(validateLocalMcpRequest(valid, "secret", 3847)).toBeNull();
    expect(validateLocalMcpRequest({ host: "127.0.0.1:3847" }, "secret", 3847)?.status).toBe(401);
    expect(validateLocalMcpRequest({ ...valid, authorization: "Bearer wrong" }, "secret", 3847)?.status).toBe(401);
    expect(validateLocalMcpRequest({ ...valid, host: "192.168.1.2:3847" }, "secret", 3847)?.status).toBe(403);
    expect(validateLocalMcpRequest({ ...valid, origin: "https://evil.example" }, "secret", 3847)?.status).toBe(403);
  });

  it("accepts the configured trycloudflare origin through trusted forwarded headers", () => {
    const settings = oauthSettings(3847, "read-only");
    const forwarded = {
      host: "127.0.0.1:3847",
      "x-forwarded-host": "aevum-oauth-fix.trycloudflare.com",
      "x-forwarded-proto": "https",
    };
    expect(validateRequestLocation(forwarded, "GET", settings)).toBeNull();
    expect(validateRequestLocation({ ...forwarded, origin: remoteOrigin }, "POST", settings)).toBeNull();
    expect(validateRequestLocation({ ...forwarded, origin: "null", referer: `${remoteOrigin}/authorize` }, "POST", settings)).toBeNull();
    expect(validateRequestLocation({ ...forwarded, origin: "https://evil.example" }, "POST", settings)?.code).toBe("TUNNEL_ORIGIN_MISMATCH");
    expect(validateRequestLocation({ ...forwarded, "x-forwarded-host": "stale.trycloudflare.com" }, "POST", settings)?.code).toBe("TUNNEL_ORIGIN_MISMATCH");
    expect(validateRequestLocation({ host: "aevum-oauth-fix.trycloudflare.com", "x-forwarded-proto": "http" }, "GET", settings)?.code).toBe("TUNNEL_ORIGIN_MISMATCH");
  });

  it("sanitizes resources and read-only tools", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings({ enabled: true, accessMode: "read-only", port });
    const client = await connectClient(port, harness.token());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("get_today_tasks");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("propose_task_changes");
    const resource = await client.readResource({ uri: "aevum://tasks/all" });
    const details = await client.callTool({ name: "get_task_details", arguments: { taskId: "task-1" } });
    const serialized = JSON.stringify({ resource, details });
    expect(serialized).toContain("Visible task");
    expect(serialized).not.toContain("api-secret");
    expect(serialized).not.toContain("telegram-secret");
    await client.close();
  });

  it("advertises object input schemas and returns object-wrapped tool and resource data", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings({ enabled: true, accessMode: "proposals", port });
    const client = await connectClient(port, harness.token());

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(8);
    for (const tool of tools.tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
    for (const name of ["get_today_tasks", "get_upcoming_tasks", "get_categories"]) {
      const schema = tools.tools.find((tool) => tool.name === name)!.inputSchema;
      expect(schema).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
    }
    expect(tools.tools.find((tool) => tool.name === "search_tasks")!.inputSchema.required).toEqual(["query"]);
    expect(tools.tools.find((tool) => tool.name === "get_task_details")!.inputSchema.required).toEqual(["taskId"]);
    expect(tools.tools.find((tool) => tool.name === "propose_task_changes")!.inputSchema.required).toEqual(["operations"]);
    expect(tools.tools.find((tool) => tool.name === "start_full_agent_workflow")!.inputSchema.required).toEqual(["instruction"]);

    const calls = [
      await client.callTool({ name: "get_today_tasks", arguments: {} }),
      await client.callTool({ name: "get_upcoming_tasks" }),
      await client.callTool({ name: "search_tasks", arguments: { query: "магазин" } }),
      await client.callTool({ name: "get_task_details", arguments: { taskId: "task-1" } }),
      await client.callTool({ name: "get_categories" }),
      await client.callTool({ name: "get_recent_activity", arguments: {} }),
    ];
    for (const result of calls) {
      expect(Array.isArray(result.structuredContent)).toBe(false);
      for (const content of result.content) {
        if (content.type === "text") expect(Array.isArray(JSON.parse(content.text))).toBe(false);
      }
    }
    expect(calls[2].structuredContent).toMatchObject({ query: "магазин", count: 1 });
    expect(calls[2].structuredContent?.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Купить продукты в магазине" })]));

    const resources = await client.listResources();
    for (const listed of resources.resources) {
      const result = await client.readResource({ uri: listed.uri });
      for (const content of result.contents) {
        if ("text" in content) expect(Array.isArray(JSON.parse(content.text))).toBe(false);
      }
    }
    const allTasks = await client.readResource({ uri: "aevum://tasks/all" });
    expect(JSON.parse(readResourceText(allTasks))).toMatchObject({ count: 2, tasks: expect.any(Array) });

    const serialized = JSON.stringify({ calls, resources: await Promise.all(resources.resources.map((item) => client.readResource({ uri: item.uri }))) });
    for (const secret of harness.secrets) expect(serialized).not.toContain(secret);
    await client.close();
  });

  it("returns a safe MCP error for array tool arguments", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings({ enabled: true, accessMode: "read-only", port });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${harness.token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_today_tasks", arguments: [] } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", error: { code: -32602, message: "Tool arguments must be a JSON object." }, id: 7 });
  });

  it("creates proposals without mutating snapshots", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings({ enabled: true, accessMode: "proposals", port });
    const client = await connectClient(port, harness.token());
    const before = JSON.stringify(harness.snapshot);
    const result = await client.callTool({
      name: "propose_task_changes",
      arguments: { operations: [{ operation: "set_status", taskId: "task-1", status: "completed" }] },
    });
    expect(JSON.stringify(result)).toContain("Proposal sent to Aevum");
    expect(result.structuredContent).toMatchObject({ proposalId: "proposal-1", status: "awaiting_confirmation" });
    expect(harness.proposals).toHaveLength(1);
    expect(JSON.stringify(harness.snapshot)).toBe(before);
    const workflow = await client.callTool({ name: "start_full_agent_workflow", arguments: { instruction: "Prepare a safe plan" } });
    expect(JSON.stringify(workflow)).toContain("Proposal sent to Aevum");
    expect(workflow.structuredContent).toMatchObject({ proposalId: "proposal-2", status: "awaiting_confirmation" });
    expect(harness.proposals).toHaveLength(2);
    expect(JSON.stringify(harness.snapshot)).toBe(before);
    await client.close();
  });

  it("stops when disabled and restarts with changed token and port", async () => {
    const firstPort = await freePort();
    const secondPort = await freePort();
    const harness = createHarness(firstPort);
    activeServices.push(harness.service);
    await harness.service.updateSettings({ enabled: true, accessMode: "read-only", port: firstPort });
    expect((await authenticatedRpc(firstPort, harness.token())).status).toBe(200);
    const oldToken = harness.token();
    await harness.service.regenerateToken();
    expect((await authenticatedRpc(firstPort, oldToken)).status).toBe(401);
    expect((await authenticatedRpc(firstPort, harness.token())).status).toBe(200);
    await harness.service.updateSettings({ enabled: true, accessMode: "read-only", port: secondPort });
    await expect(fetch(`http://127.0.0.1:${firstPort}/mcp`)).rejects.toThrow();
    expect((await authenticatedRpc(secondPort, harness.token())).status).toBe(200);
    await harness.service.updateSettings({ enabled: false, accessMode: "read-only", port: secondPort });
    await expect(fetch(`http://127.0.0.1:${secondPort}/mcp`)).rejects.toThrow();
  });

  it("starts one auto tunnel, adopts its generated origin, and stops it when MCP is disabled", async () => {
    const port = await freePort();
    const child = new ServiceTunnelProcess();
    let spawnCount = 0;
    const quickTunnel = new CloudflareQuickTunnel({
      locate: async () => "cloudflared.exe",
      spawn: () => { spawnCount += 1; return child as never; },
      startupTimeoutMs: 1_000,
    });
    const harness = createHarness(port, quickTunnel);
    activeServices.push(harness.service);
    const starting = harness.service.updateSettings({
      enabled: true,
      accessMode: "read-only",
      port,
      authenticationMode: "oauth",
      remoteUrl: "https://dead-link.trycloudflare.com",
      tunnelMode: "temporary",
    });
    await Promise.resolve();
    await Promise.resolve();
    child.stderr.write("https://fresh-link.trycloudflare.com");
    const status = await starting;
    expect(spawnCount).toBe(1);
    expect(status.remoteUrl).toBe("https://fresh-link.trycloudflare.com");
    expect(status.remoteEndpoint).toBe("https://fresh-link.trycloudflare.com/mcp");
    expect(status.tunnel).toMatchObject({ state: "running", connectorUrl: "https://fresh-link.trycloudflare.com/mcp" });
    const persistent = await harness.service.updateSettings(oauthSettings(port, "read-only"));
    expect(child.killed).toBe(true);
    expect(persistent).toMatchObject({ tunnelMode: "persistent", remoteUrl: remoteOrigin, remoteEndpoint: `${remoteOrigin}/mcp` });
    expect((await remoteFetch(port, "/.well-known/oauth-protected-resource/mcp")).status).toBe(200);
  });

  it("publishes OAuth metadata, registers a client, and issues a short-lived scoped token", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings(oauthSettings(port, "proposals"));

    const mismatch = await remoteFetch(port, "/.well-known/oauth-authorization-server", {
      headers: { "X-Forwarded-Host": "stale-tunnel.trycloudflare.com" },
    });
    expect(mismatch.status).toBe(403);
    expect(JSON.stringify(await mismatch.json())).toContain("Tunnel origin mismatch");
    expect((await harness.service.getStatus()).message).toContain(`Expected ${remoteOrigin}`);

    const protectedMetadata = await remoteFetch(port, "/.well-known/oauth-protected-resource/mcp");
    expect(protectedMetadata.status).toBe(200);
    expect((await harness.service.getStatus()).message).toBeUndefined();
    expect(await protectedMetadata.json()).toMatchObject({
      resource: `${remoteOrigin}/mcp`,
      authorization_servers: [`${remoteOrigin}/`],
      scopes_supported: ["mcp:read", "mcp:propose"],
    });
    const rootMetadata = await remoteFetch(port, "/.well-known/oauth-protected-resource");
    expect(rootMetadata.status).toBe(200);

    const authorizationMetadata = await remoteFetch(port, "/.well-known/oauth-authorization-server");
    expect(await authorizationMetadata.json()).toMatchObject({
      issuer: `${remoteOrigin}/`,
      authorization_endpoint: `${remoteOrigin}/authorize`,
      token_endpoint: `${remoteOrigin}/token`,
      registration_endpoint: `${remoteOrigin}/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const grant = await authorizeOAuthClient(port, ["mcp:read"]);
    expect(grant.tokens).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "mcp:read" });
    expect(grant.tokens.access_token).toBeTruthy();
    expect(grant.tokens.refresh_token).toBeTruthy();
    const reused = await exchangeOAuthGrant(port, grant, grant.verifier);
    expect(reused.status).toBe(400);
  });

  it("rejects invalid OAuth tokens and enforces MCP proposal scopes", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings(oauthSettings(port, "proposals"));

    const invalid = await oauthRpc(port, "not-a-token");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");

    const pkceGrant = await beginOAuthGrant(port, ["mcp:read"]);
    expect((await exchangeOAuthGrant(port, pkceGrant, "incorrect-verifier")).status).toBe(400);
    expect((await exchangeOAuthGrant(port, pkceGrant, pkceGrant.verifier)).status).toBe(200);

    const readGrant = await authorizeOAuthClient(port, ["mcp:read"]);
    const readClient = await connectOAuthClient(port, readGrant.tokens.access_token);
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain("propose_task_changes");
    await readClient.close();

    const proposalGrant = await authorizeOAuthClient(port, ["mcp:read", "mcp:propose"]);
    const proposalClient = await connectOAuthClient(port, proposalGrant.tokens.access_token);
    expect((await proposalClient.listTools()).tools.map((tool) => tool.name)).toContain("propose_task_changes");
    const resource = await proposalClient.readResource({ uri: "aevum://tasks/all" });
    const serialized = JSON.stringify(resource);
    expect(serialized).not.toContain("api-secret");
    expect(serialized).not.toContain("telegram-secret");
    expect(serialized).not.toContain(proposalGrant.tokens.access_token);
    await proposalClient.close();
  });

  it("exposes full-access productivity tools only to the write scope and keeps writes confirmation-based", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings(oauthSettings(port, "full-access"));

    const metadata = await remoteFetch(port, "/.well-known/oauth-protected-resource/mcp");
    expect(await metadata.json()).toMatchObject({ scopes_supported: ["mcp:read", "mcp:propose", "mcp:write"] });
    const challenge = await unauthenticatedOAuthRpc(port);
    expect(challenge.headers.get("www-authenticate")).toContain('scope="mcp:read mcp:propose mcp:write"');

    const readGrant = await authorizeOAuthClient(port, ["mcp:read"]);
    const readClient = await connectOAuthClient(port, readGrant.tokens.access_token);
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain("create_tasks");
    expect((await readClient.callTool({ name: "create_tasks", arguments: { tasks: [{ title: "Blocked" }] } })).isError).toBe(true);
    await readClient.close();

    const proposalGrant = await authorizeOAuthClient(port, ["mcp:read", "mcp:propose"]);
    const proposalClient = await connectOAuthClient(port, proposalGrant.tokens.access_token);
    const proposalTools = (await proposalClient.listTools()).tools.map((tool) => tool.name);
    expect(proposalTools).toContain("propose_task_changes");
    expect(proposalTools).not.toContain("create_tasks");
    expect((await proposalClient.callTool({ name: "create_tasks", arguments: { tasks: [{ title: "Blocked" }] } })).isError).toBe(true);
    await proposalClient.close();

    const fullGrant = await authorizeOAuthClient(port, ["mcp:read", "mcp:propose", "mcp:write"]);
    expect(fullGrant.consentHtml).toContain("Full Access");
    expect(fullGrant.tokens.scope).toBe("mcp:read mcp:propose mcp:write");
    const refreshed = await refreshOAuthGrant(port, fullGrant);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ scope: "mcp:read mcp:propose mcp:write" });
    const fullClient = await connectOAuthClient(port, fullGrant.tokens.access_token);
    const fullToolDefinitions = (await fullClient.listTools()).tools;
    const fullTools = fullToolDefinitions.map((tool) => tool.name);
    expect(fullTools).toEqual(expect.arrayContaining([
      "create_tasks", "update_task", "reschedule_task", "set_task_status", "delete_task",
      "assign_task_to_category", "create_category", "rename_category", "start_full_agent_workflow",
    ]));
    expect(fullTools.some((name) => /secret|token|setting|system|cache|model|telegram/i.test(name))).toBe(false);
    for (const tool of fullToolDefinitions) {
      expect(tool.inputSchema).toMatchObject({ type: "object", properties: expect.any(Object), additionalProperties: false });
    }

    const before = JSON.stringify(harness.snapshot);
    const result = await fullClient.callTool({
      name: "create_tasks",
      arguments: { tasks: [{ title: "Created through MCP" }] },
    });
    expect(result.structuredContent).toMatchObject({ proposalId: "proposal-1", status: "awaiting_confirmation" });
    expect(Array.isArray(result.structuredContent)).toBe(false);
    expect(harness.proposals).toEqual([{ kind: "productivity_action", action: { type: "create_tasks", tasks: [{ title: "Created through MCP" }] } }]);
    expect(JSON.stringify(harness.snapshot)).toBe(before);
    const writeCalls = [
      ["update_task", { taskId: "task-1", changes: { title: "Updated" } }],
      ["reschedule_task", { taskId: "task-1", scheduledAt: "2026-06-23T09:00:00" }],
      ["set_task_status", { taskId: "task-1", status: "completed" }],
      ["delete_task", { taskId: "task-1" }],
      ["assign_task_to_category", { taskId: "task-1", categoryId: "uncategorized" }],
      ["create_category", { name: "Work" }],
      ["rename_category", { categoryId: "uncategorized", name: "Inbox renamed" }],
      ["propose_task_changes", { operations: [{ operation: "set_status", taskId: "task-1", status: "completed" }] }],
      ["start_full_agent_workflow", { instruction: "Prepare a safe plan" }],
    ] as const;
    for (const [name, argumentsValue] of writeCalls) {
      const writeResult = await fullClient.callTool({ name, arguments: argumentsValue });
      expect(Array.isArray(writeResult.structuredContent), name).toBe(false);
      expect(writeResult.structuredContent, name).toMatchObject({ status: "awaiting_confirmation" });
      for (const content of writeResult.content) {
        if (content.type === "text") expect(Array.isArray(JSON.parse(content.text)), name).toBe(false);
      }
    }
    expect(JSON.stringify(harness.snapshot)).toBe(before);
    expect(await harness.service.getStatus()).toMatchObject({
      toolAccess: {
        selectedMode: "full-access",
        grantedScopes: ["mcp:read", "mcp:propose", "mcp:write"],
        registeredClientCount: 3,
        writeToolsExposed: true,
        lastToolListMode: "full-access",
      },
    });
    await fullClient.close();
  });

  it("invalidates old grants and a ChatGPT-like reconnect receives expanded Full Access tools", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    await harness.service.updateSettings(oauthSettings(port, "read-only"));
    const oldGrant = await authorizeOAuthClient(port, ["mcp:read"]);
    const oldClient = await connectOAuthClient(port, oldGrant.tokens.access_token);
    expect((await oldClient.listTools()).tools.map((tool) => tool.name)).not.toContain("create_tasks");
    await oldClient.close();

    await harness.service.updateSettings(oauthSettings(port, "full-access"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await oauthRpc(port, oldGrant.tokens.access_token)).status).toBe(401);
    const challenge = await unauthenticatedOAuthRpc(port);
    const advertisedScopes = challenge.headers.get("www-authenticate")?.match(/scope="([^"]+)"/)?.[1].split(" ") ?? [];
    expect(advertisedScopes).toEqual(["mcp:read", "mcp:propose", "mcp:write"]);

    const reconnectedGrant = await authorizeOAuthClient(port, advertisedScopes);
    const reconnectedClient = await connectOAuthClient(port, reconnectedGrant.tokens.access_token);
    const tools = (await reconnectedClient.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["create_tasks", "update_task", "delete_task", "propose_task_changes"]));
    await reconnectedClient.close();
  });

  it("rejects invalid persistent public origins without binding publicly", async () => {
    const port = await freePort();
    const harness = createHarness(port);
    activeServices.push(harness.service);
    const status = await harness.service.updateSettings({
      ...oauthSettings(port, "read-only"),
      remoteUrl: "http://aevum.example.com/mcp",
    });
    expect(status.status).toBe("error");
    expect(status.message).toBe("OAuth requires a valid HTTPS tunnel URL.");
    expect(status.endpoint).toBe(`http://127.0.0.1:${port}/mcp`);
  });
});

const remoteOrigin = "https://aevum-oauth-fix.trycloudflare.com";

function oauthSettings(port: number, accessMode: "read-only" | "proposals" | "full-access") {
  return { enabled: true, accessMode, port, authenticationMode: "oauth" as const, remoteUrl: remoteOrigin, tunnelMode: "persistent" as const };
}

async function authorizeOAuthClient(port: number, scopes: string[]) {
  const grant = await beginOAuthGrant(port, scopes);
  const tokenResponse = await exchangeOAuthGrant(port, grant, grant.verifier);
  expect(tokenResponse.status).toBe(200);
  return { ...grant, tokens: await tokenResponse.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string } };
}

async function beginOAuthGrant(port: number, scopes: string[]) {
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registration = await remoteFetch(port, "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT test connector",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: scopes.join(" "),
    }),
  });
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/authorize", remoteOrigin);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "test-state",
    resource: `${remoteOrigin}/mcp`,
    scope: scopes.join(" "),
  }).toString();
  const consent = await remoteFetch(port, `${authorize.pathname}${authorize.search}`);
  expect(consent.status).toBe(200);
  const consentHtml = await consent.text();
  const consentId = consentHtml.match(/name="consent_id" value="([^"]+)"/)?.[1];
  expect(consentId).toBeTruthy();
  const approval = await remoteFetch(port, "/oauth/decision", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: remoteOrigin },
    body: new URLSearchParams({ consent_id: consentId!, decision: "approve" }),
    redirect: "manual",
  });
  expect(approval.status).toBe(200);
  const waitingHtml = await approval.text();
  const statusUrl = waitingHtml.match(/const endpoint="([^"]+)"/)?.[1];
  expect(statusUrl).toBeTruthy();
  const statusPath = new URL(statusUrl!).pathname;
  let redirectUrl = "";
  for (let attempt = 0; attempt < 20 && !redirectUrl; attempt += 1) {
    const status = await remoteFetch(port, statusPath);
    const payload = await status.json() as { redirectUrl?: string };
    redirectUrl = payload.redirectUrl ?? "";
    if (!redirectUrl) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(redirectUrl).toBeTruthy();
  const callback = new URL(redirectUrl);
  expect(callback.searchParams.get("state")).toBe("test-state");
  return { client, verifier, code: callback.searchParams.get("code")!, redirectUri, consentHtml };
}

function exchangeOAuthGrant(port: number, grant: { client: { client_id: string }; code: string; redirectUri: string }, verifier: string) {
  return remoteFetch(port, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: grant.client.client_id,
      code: grant.code,
      code_verifier: verifier,
      redirect_uri: grant.redirectUri,
      resource: `${remoteOrigin}/mcp`,
    }),
  });
}

function refreshOAuthGrant(port: number, grant: { client: { client_id: string }; tokens: { refresh_token: string } }) {
  return remoteFetch(port, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: grant.client.client_id,
      refresh_token: grant.tokens.refresh_token,
      resource: `${remoteOrigin}/mcp`,
    }),
  });
}

function remoteFetch(port: number, path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      Host: `127.0.0.1:${port}`,
      "X-Forwarded-Host": "aevum-oauth-fix.trycloudflare.com",
      "X-Forwarded-Proto": "https",
      ...init.headers,
    },
  });
}

async function connectOAuthClient(port: number, token: string) {
  const client = new Client({ name: "aevum-oauth-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: {
      Authorization: `Bearer ${token}`,
      Host: `127.0.0.1:${port}`,
      "X-Forwarded-Host": "aevum-oauth-fix.trycloudflare.com",
      "X-Forwarded-Proto": "https",
    } },
  });
  await client.connect(transport);
  return client;
}

function oauthRpc(port: number, token: string) {
  return remoteFetch(port, "/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
}

function unauthenticatedOAuthRpc(port: number) {
  return remoteFetch(port, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chatgpt-like", version: "1" } } }),
  });
}

function createHarness(port: number, quickTunnel?: CloudflareQuickTunnel) {
  let token = "initial-token-value";
  let tokenCounter = 0;
  const proposals: McpProposalRequest[] = [];
  const snapshot = {
    tasks: [
      { id: "task-1", title: "Visible task", description: "Safe", status: "active", scheduledAt: "2026-06-21", projectId: "uncategorized", tags: ["work"], subtasks: [], internalPrompt: "prompt-secret" },
      { id: "task-2", title: "Купить продукты в магазине", description: "Молоко", status: "active", scheduledAt: "2026-06-22", projectId: "uncategorized", tags: ["дом"], subtasks: [], refreshToken: "refresh-secret" },
    ],
    categories: [{ id: "uncategorized", name: "Inbox", color: "sage", description: "", mcpToken: "mcp-secret" }],
    activity: [{ transactionId: "tx-1", source: "mcp", actionKind: "update", appliedAt: "2026-06-21T12:00:00Z", status: "applied", summary: { kind: "update", taskCount: 1, rawDebugState: "debug-secret" }, oauthSession: "oauth-secret" }],
    app: { ready: true, language: "en" },
    apiKey: "api-secret",
    telegramToken: "telegram-secret",
    openRouterKey: "openrouter-secret",
  };
  const service = new AevumMcpService({
    getToken: async () => token,
    setToken: async (value) => { token = value; },
    generateToken: () => `regenerated-token-${++tokenCounter}`,
    requestSnapshot: async () => snapshot,
    requestProposal: async (request) => {
      proposals.push(request);
      return { ok: true, proposalId: `proposal-${proposals.length}` };
    },
    confirmOAuthAccess: async () => true,
    quickTunnel,
  });
  return {
    service,
    proposals,
    snapshot,
    token: () => token,
    port,
    secrets: ["api-secret", "telegram-secret", "openrouter-secret", "prompt-secret", "refresh-secret", "mcp-secret", "debug-secret", "oauth-secret"],
  };
}

function readResourceText(result: { contents: Array<{ text?: string }> }) {
  const text = result.contents.find((content) => typeof content.text === "string")?.text;
  if (!text) throw new Error("Expected JSON text resource content.");
  return text;
}

class ServiceTunnelProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

async function connectClient(port: number, token: string) {
  const client = new Client({ name: "aevum-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function authenticatedRpc(port: number, token: string) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

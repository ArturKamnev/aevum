import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { RelayConfig } from "./config.js";
import type { RelayDatabase } from "./database.js";
import { accessModeSchema, desktopMessageSchema, isAccessModeExpansion, scopesForMode, type AccessMode, type RelayMessage } from "./protocol.js";
import { hashSecret, randomToken, safeHashEqual, signAccessToken, verifyAccessTokenDetailed, verifyPkceS256 } from "./security.js";

const mcpTimeoutMs = 12_000;
const approvalTimeoutMs = 3 * 60_000;
const codeTtlMs = 2 * 60_000;
const sessionTtlMs = 10 * 60_000;
const accessTokenTtlMs = 60 * 60_000;
const refreshTokenFamilyTtlMs = 60 * 24 * 60 * 60_000;
const maxHttpBodyBytes = 512 * 1024;

type PendingRequest = { devicePublicId: string; timer: NodeJS.Timeout; resolve: (value: unknown) => void; reject: (error: Error) => void };
type DeviceConnection = { socket: WebSocket; devicePublicId: string; accessMode: AccessMode; alive: boolean };

export function createRelayServer(config: RelayConfig, database: RelayDatabase) {
  const hub = new DeviceHub(config, database);
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = firstHeader(request.headers["x-request-id"]) ?? randomUUID();
    response.setHeader("X-Request-Id", requestId);
    try {
      await routeRequest(request, response, { config, database, hub, requestId });
    } catch (error) {
      log("error", "request_failed", { requestId, method: request.method, path: safePath(request.url), error: safeError(error) });
      if (!response.headersSent) sendJson(response, 500, { error: "server_error", error_description: "The relay could not complete the request." });
      else response.end();
    } finally {
      log("info", "request_complete", { requestId, method: request.method, path: safePath(request.url), status: response.statusCode, durationMs: Date.now() - startedAt });
    }
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", config.publicOrigin);
    if (url.pathname !== "/device/connect") return socket.destroy();
    webSockets.handleUpgrade(request, socket, head, (webSocket) => hub.accept(webSocket));
  });

  let shuttingDown = false;
  return {
    server,
    hub,
    isShuttingDown: () => shuttingDown,
    async shutdown() {
      shuttingDown = true;
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.end();
    },
  };
}

type RouteContext = { config: RelayConfig; database: RelayDatabase; hub: DeviceHub; requestId: string };

async function routeRequest(request: IncomingMessage, response: ServerResponse, context: RouteContext) {
  const url = new URL(request.url ?? "/", context.config.publicOrigin);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");

  if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
  if (request.method === "GET" && url.pathname === "/readyz") {
    try { await context.database.query("SELECT 1"); return sendJson(response, 200, { status: "ready" }); }
    catch { return sendJson(response, 503, { status: "not_ready" }); }
  }
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return authorizationMetadata(response, context.config);
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") return sendJson(response, 200, {
    authorization_servers: [context.config.publicOrigin], resource_name: "Aevum Connect Relay",
  });
  const protectedMatch = url.pathname.match(/^\/\.well-known\/oauth-protected-resource\/mcp\/([A-Za-z0-9_-]{24,128})$/);
  if (request.method === "GET" && protectedMatch) return protectedResourceMetadata(response, context, protectedMatch[1]);
  if (request.method === "POST" && url.pathname === "/register") return registerClient(request, response, context);
  if (request.method === "GET" && url.pathname === "/authorize") return authorize(request, response, context, url);
  if (request.method === "POST" && url.pathname === "/oauth/decision") return decideAuthorization(request, response, context);
  const sessionMatch = url.pathname.match(/^\/oauth\/session\/([A-Za-z0-9_-]{24,200})\/status$/);
  if (request.method === "GET" && sessionMatch) return authorizationStatus(response, context, sessionMatch[1]);
  if (request.method === "POST" && url.pathname === "/token") return exchangeToken(request, response, context);
  if (request.method === "POST" && url.pathname === "/revoke") return revokeToken(request, response, context);
  const deviceClientsMatch = url.pathname.match(/^\/device\/([A-Za-z0-9_-]{24,128})\/clients$/);
  if (deviceClientsMatch && request.method === "GET") return listDeviceClients(request, response, context, deviceClientsMatch[1]);
  if (deviceClientsMatch && request.method === "DELETE") return revokeAllDeviceClients(request, response, context, deviceClientsMatch[1]);
  const deviceClientMatch = url.pathname.match(/^\/device\/([A-Za-z0-9_-]{24,128})\/clients\/([A-Za-z0-9_-]{8,200})$/);
  if (deviceClientMatch && request.method === "DELETE") return revokeDeviceClient(request, response, context, deviceClientMatch[1], deviceClientMatch[2]);
  const deviceResetMatch = url.pathname.match(/^\/device\/([A-Za-z0-9_-]{24,128})$/);
  if (deviceResetMatch && request.method === "DELETE") return resetDeviceIdentity(request, response, context, deviceResetMatch[1]);
  const mcpMatch = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{24,128})$/);
  if (request.method === "POST" && mcpMatch) return forwardMcp(request, response, context, mcpMatch[1]);
  sendJson(response, 404, { error: "not_found" });
}

async function authenticateDeviceRequest(request: IncomingMessage, response: ServerResponse, context: RouteContext, devicePublicId: string) {
  const authorization = request.headers.authorization;
  const secret = authorization?.startsWith("Device ") ? authorization.slice(7) : "";
  const result = await context.database.query("SELECT device_secret_hash FROM relay_devices WHERE device_public_id=$1 AND revoked_at IS NULL", [devicePublicId]);
  if (!secret || !result.rows[0] || !safeHashEqual(secret, result.rows[0].device_secret_hash, context.config.tokenSecret)) {
    sendJson(response, 401, { error: "invalid_device_credentials" });
    return false;
  }
  return true;
}

async function listDeviceClients(request: IncomingMessage, response: ServerResponse, context: RouteContext, devicePublicId: string) {
  if (!await authenticateDeviceRequest(request, response, context, devicePublicId)) return;
  const result = await context.database.query(
    `SELECT c.client_id,c.client_name,g.scopes,g.created_at,g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.client_id=g.client_id
     WHERE g.device_public_id=$1 AND g.revoked_at IS NULL ORDER BY g.last_used_at DESC NULLS LAST`,
    [devicePublicId],
  );
  const diagnostics = (await context.database.query("SELECT last_oauth_stage,last_token_error,grant_found,last_refresh_rotation_success,updated_at FROM oauth_diagnostics WHERE device_public_id=$1", [devicePublicId])).rows[0];
  sendJson(response, 200, {
    clients: result.rows.map((row) => ({ clientId: row.client_id, name: row.client_name, scopes: row.scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at })),
    count: result.rowCount ?? 0,
    diagnostics: diagnostics ? { lastOAuthStage: diagnostics.last_oauth_stage, lastTokenError: diagnostics.last_token_error, grantFound: diagnostics.grant_found, persistentGrantExists: (result.rowCount ?? 0) > 0, refreshRotationSuccess: diagnostics.last_refresh_rotation_success, updatedAt: diagnostics.updated_at } : { persistentGrantExists: (result.rowCount ?? 0) > 0 },
  });
}

async function revokeDeviceClient(request: IncomingMessage, response: ServerResponse, context: RouteContext, devicePublicId: string, clientId: string) {
  if (!await authenticateDeviceRequest(request, response, context, devicePublicId)) return;
  await context.database.query("UPDATE oauth_grants SET revoked_at=NOW(),token_version=token_version+1 WHERE device_public_id=$1 AND client_id=$2 AND revoked_at IS NULL", [devicePublicId, clientId]);
  await context.database.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE grant_id IN (SELECT grant_id FROM oauth_grants WHERE device_public_id=$1 AND client_id=$2)", [devicePublicId, clientId]);
  context.hub.notifyClientRevoked(devicePublicId, clientId);
  sendJson(response, 200, { revoked: true, clientId });
}

async function revokeAllDeviceClients(request: IncomingMessage, response: ServerResponse, context: RouteContext, devicePublicId: string) {
  if (!await authenticateDeviceRequest(request, response, context, devicePublicId)) return;
  await context.database.query("UPDATE oauth_grants SET revoked_at=NOW(),token_version=token_version+1 WHERE device_public_id=$1 AND revoked_at IS NULL", [devicePublicId]);
  await context.database.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE grant_id IN (SELECT grant_id FROM oauth_grants WHERE device_public_id=$1)", [devicePublicId]);
  context.hub.notifyClientRevoked(devicePublicId);
  sendJson(response, 200, { revoked: true, all: true });
}

async function resetDeviceIdentity(request: IncomingMessage, response: ServerResponse, context: RouteContext, devicePublicId: string) {
  if (!await authenticateDeviceRequest(request, response, context, devicePublicId)) return;
  await context.hub.resetDevice(devicePublicId);
  sendJson(response, 200, { reset: true });
}

function authorizationMetadata(response: ServerResponse, config: RelayConfig) {
  sendJson(response, 200, {
    issuer: config.publicOrigin,
    authorization_endpoint: `${config.publicOrigin}/authorize`,
    token_endpoint: `${config.publicOrigin}/token`,
    registration_endpoint: `${config.publicOrigin}/register`,
    revocation_endpoint: `${config.publicOrigin}/revoke`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:read", "mcp:propose", "mcp:write"],
  });
}

async function protectedResourceMetadata(response: ServerResponse, context: RouteContext, devicePublicId: string) {
  const device = await getActiveDevice(context.database, devicePublicId);
  if (!device) return sendJson(response, 404, { error: "unknown_device" });
  sendJson(response, 200, {
    resource: `${context.config.publicOrigin}/mcp/${devicePublicId}`,
    authorization_servers: [context.config.publicOrigin],
    scopes_supported: scopesForMode(device.access_mode),
    resource_name: "Aevum Connect",
  });
}

async function registerClient(request: IncomingMessage, response: ServerResponse, context: RouteContext) {
  const body = await readJson(request);
  if (!isRecord(body) || !Array.isArray(body.redirect_uris) || !body.redirect_uris.every(isSafeRedirectUri)) {
    return sendOAuthError(response, 400, "invalid_client_metadata", "Valid HTTPS redirect_uris are required.");
  }
  const clientId = randomToken(24);
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 300) : "MCP client";
  await context.database.query("INSERT INTO oauth_clients(client_id,client_name,redirect_uris) VALUES($1,$2,$3::jsonb)", [clientId, clientName, JSON.stringify(body.redirect_uris)]);
  log("info", "oauth_client_registered", { clientIdSuffix: clientId.slice(-6) });
  sendJson(response, 201, {
    client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientName,
    redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  });
}

async function authorize(_request: IncomingMessage, response: ServerResponse, context: RouteContext, url: URL) {
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const resource = url.searchParams.get("resource") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const state = url.searchParams.get("state");
  let devicePublicId = "";
  try {
    const resourceUrl = new URL(resource);
    if (resourceUrl.origin === context.config.publicOrigin && !resourceUrl.search && !resourceUrl.hash) {
      devicePublicId = resourceUrl.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{24,128})$/)?.[1] ?? "";
    }
  } catch {}
  const [clientResult, device] = await Promise.all([
    context.database.query("SELECT * FROM oauth_clients WHERE client_id=$1", [clientId]),
    getActiveDevice(context.database, devicePublicId),
  ]);
  const client = clientResult.rows[0];
  if (!client || !(client.redirect_uris as string[]).includes(redirectUri) || !device || url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" || codeChallenge.length < 43) {
    return sendOAuthError(response, 400, "invalid_request", "The authorization request is invalid.");
  }
  const allowed = scopesForMode(device.access_mode);
  const requested = (url.searchParams.get("scope")?.split(/\s+/).filter(Boolean) ?? allowed);
  if (!requested.includes("mcp:read") || requested.some((scope) => !allowed.includes(scope))) {
    log("warn", "oauth_authorize_rejected", { reason: "invalid_scope", deviceIdSuffix: devicePublicId.slice(-6), clientIdSuffix: clientId.slice(-6) });
    return redirectOAuthError(response, redirectUri, state, "invalid_scope");
  }

  const grant = (await context.database.query("SELECT * FROM oauth_grants WHERE device_public_id=$1 AND client_id=$2 AND revoked_at IS NULL", [devicePublicId, clientId])).rows[0];
  await updateOAuthDiagnostics(context.database, devicePublicId, { stage: grant ? "grant_reuse_checked" : "grant_creation_required", grantFound: Boolean(grant) });
  if (grant && requested.every((scope) => (grant.scopes as string[]).includes(scope))) {
    const code = await createAuthorizationCode(context, { devicePublicId, clientId, redirectUri, scopes: requested, codeChallenge, sessionId: `reuse-${randomToken(18)}` });
    return redirectWithCode(response, redirectUri, state, code);
  }

  const sessionId = randomToken(32);
  await context.database.query(
    "INSERT INTO oauth_sessions(session_id,device_public_id,client_id,redirect_uri,scopes,state,code_challenge,stage,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'pending_browser_consent',$8)",
    [sessionId, devicePublicId, clientId, redirectUri, JSON.stringify(requested), state, codeChallenge, new Date(Date.now() + sessionTtlMs)],
  );
  sendHtml(response, 200, renderConsent({ sessionId, clientName: client.client_name, scopes: requested, action: `${context.config.publicOrigin}/oauth/decision` }));
}

async function decideAuthorization(request: IncomingMessage, response: ServerResponse, context: RouteContext) {
  const form = await readForm(request);
  const sessionId = form.get("consent_id") ?? "";
  const result = await context.database.query("SELECT s.*,c.client_name FROM oauth_sessions s JOIN oauth_clients c ON c.client_id=s.client_id WHERE session_id=$1 AND stage='pending_browser_consent' AND expires_at>NOW()", [sessionId]);
  const session = result.rows[0];
  if (!session) return sendHtml(response, 400, "Authorization request expired.");
  if (form.get("decision") !== "approve") {
    const redirectUrl = oauthRedirect(session.redirect_uri, session.state, { error: "access_denied" });
    await context.database.query("UPDATE oauth_sessions SET stage='denied',redirect_url=$2 WHERE session_id=$1", [sessionId, redirectUrl]);
    response.writeHead(302, { Location: redirectUrl }).end();
    return;
  }
  await context.database.query("UPDATE oauth_sessions SET stage='pending_native_approval' WHERE session_id=$1", [sessionId]);
  sendHtml(response, 200, renderWaiting(`${context.config.publicOrigin}/oauth/session/${encodeURIComponent(sessionId)}/status`));
  void completeNativeApproval(context, session).catch((error) => log("warn", "native_approval_failed", { error: safeError(error) }));
}

async function completeNativeApproval(context: RouteContext, session: Record<string, any>) {
  let approved = false;
  try {
    approved = await context.hub.requestApproval(session.device_public_id, {
      clientName: session.client_name, redirectUri: session.redirect_uri, scopes: session.scopes,
    });
  } catch {}
  const current = (await context.database.query("SELECT * FROM oauth_sessions WHERE session_id=$1 AND stage='pending_native_approval' AND expires_at>NOW()", [session.session_id])).rows[0];
  if (!current) return;
  if (!approved) {
    const redirectUrl = oauthRedirect(current.redirect_uri, current.state, { error: "access_denied" });
    await context.database.query("UPDATE oauth_sessions SET stage='denied',redirect_url=$2 WHERE session_id=$1", [current.session_id, redirectUrl]);
    return;
  }
  const code = await createAuthorizationCode(context, {
    devicePublicId: current.device_public_id, clientId: current.client_id, redirectUri: current.redirect_uri,
    scopes: current.scopes, codeChallenge: current.code_challenge, sessionId: current.session_id,
  });
  const redirectUrl = oauthRedirect(current.redirect_uri, current.state, { code });
  await context.database.query("UPDATE oauth_sessions SET stage='approved',redirect_url=$2 WHERE session_id=$1", [current.session_id, redirectUrl]);
}

async function authorizationStatus(response: ServerResponse, context: RouteContext, sessionId: string) {
  const session = (await context.database.query("SELECT stage,redirect_url,expires_at FROM oauth_sessions WHERE session_id=$1", [sessionId])).rows[0];
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return sendJson(response, 404, { stage: "expired", error: "Authorization request expired." });
  sendJson(response, 200, { stage: session.stage, ...(session.redirect_url ? { redirectUrl: session.redirect_url } : {}) });
}

async function createAuthorizationCode(context: RouteContext, input: { devicePublicId: string; clientId: string; redirectUri: string; scopes: string[]; codeChallenge: string; sessionId: string }) {
  const code = randomToken(32);
  await context.database.query(
    "INSERT INTO authorization_codes(code_hash,session_id,device_public_id,client_id,redirect_uri,scopes,code_challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
    [hashSecret(code, context.config.tokenSecret), input.sessionId, input.devicePublicId, input.clientId, input.redirectUri, JSON.stringify(input.scopes), input.codeChallenge, new Date(Date.now() + codeTtlMs)],
  );
  return code;
}

async function exchangeToken(request: IncomingMessage, response: ServerResponse, context: RouteContext) {
  const form = await readForm(request);
  if (form.get("grant_type") === "authorization_code") return exchangeAuthorizationCode(response, context, form);
  if (form.get("grant_type") === "refresh_token") return exchangeRefreshToken(response, context, form);
  sendOAuthError(response, 400, "unsupported_grant_type", "Unsupported grant type.");
}

async function exchangeAuthorizationCode(response: ServerResponse, context: RouteContext, form: URLSearchParams) {
  const code = form.get("code") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const client = await context.database.connect();
  let devicePublicId: string | undefined;
  try {
    await client.query("BEGIN");
    const row = (await client.query("SELECT * FROM authorization_codes WHERE code_hash=$1 FOR UPDATE", [hashSecret(code, context.config.tokenSecret)])).rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now() || row.client_id !== clientId || row.redirect_uri !== redirectUri || !verifyPkceS256(verifier, row.code_challenge)) throw new Error("invalid_grant");
    devicePublicId = row.device_public_id;
    await client.query("UPDATE authorization_codes SET consumed_at=NOW() WHERE code_hash=$1", [row.code_hash]);
    const grantId = randomToken(24);
    const grant = (await client.query(
      "INSERT INTO oauth_grants(grant_id,device_public_id,client_id,scopes) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(device_public_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,last_used_at=NOW(),revoked_at=NULL RETURNING *",
      [grantId, row.device_public_id, clientId, JSON.stringify(row.scopes)],
    )).rows[0];
    const tokens = await createTokenPair(client, context.config, grant, randomToken(24));
    await client.query("COMMIT");
    sendJson(response, 200, tokens);
    log("info", "oauth_authorization_code_exchanged", { deviceIdSuffix: grant.device_public_id.slice(-6), clientIdSuffix: clientId.slice(-6), scopes: grant.scopes });
    void updateOAuthDiagnostics(context.database, grant.device_public_id, { stage: "authorization_code_exchanged", tokenError: null }).catch(() => undefined);
  } catch (error) {
    await client.query("ROLLBACK");
    log("warn", "oauth_authorization_code_rejected", { reason: safeOAuthReason(error), clientIdSuffix: clientId.slice(-6) });
    if (devicePublicId) void updateOAuthDiagnostics(context.database, devicePublicId, { stage: "authorization_code_rejected", tokenError: "invalid_grant" }).catch(() => undefined);
    sendOAuthError(response, 400, "invalid_grant", "Invalid or expired authorization code.");
  } finally { client.release(); }
}

async function exchangeRefreshToken(response: ServerResponse, context: RouteContext, form: URLSearchParams) {
  const raw = form.get("refresh_token") ?? "";
  const clientId = form.get("client_id") ?? "";
  const hash = hashSecret(raw, context.config.tokenSecret);
  const client = await context.database.connect();
  let token: Record<string, any> | undefined;
  try {
    await client.query("BEGIN");
    token = (await client.query("SELECT r.*,g.device_public_id,g.client_id,g.scopes,g.token_version,g.revoked_at AS grant_revoked_at,d.revoked_at AS device_revoked_at FROM refresh_tokens r JOIN oauth_grants g ON g.grant_id=r.grant_id JOIN relay_devices d ON d.device_public_id=g.device_public_id JOIN oauth_clients c ON c.client_id=g.client_id WHERE r.token_hash=$1 FOR UPDATE", [hash])).rows[0];
    if (!token) throw new Error("refresh_token_missing");
    if (clientId && token.client_id !== clientId) throw new Error("client_mismatch");
    if (token.revoked_at || token.grant_revoked_at || token.device_revoked_at) throw new Error("grant_revoked");
    if (new Date(token.expires_at).getTime() <= Date.now() || new Date(token.family_expires_at).getTime() <= Date.now()) throw new Error("refresh_token_expired");
    if (token.consumed_at) {
      await client.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE family_id=$1", [token.family_id]);
      await client.query("UPDATE oauth_grants SET revoked_at=NOW(),token_version=token_version+1 WHERE grant_id=$1", [token.grant_id]);
      await client.query("COMMIT");
      log("warn", "oauth_refresh_token_reuse", { deviceIdSuffix: token.device_public_id.slice(-6), clientIdSuffix: token.client_id.slice(-6), familyRevoked: true });
      void updateOAuthDiagnostics(context.database, token.device_public_id, { stage: "refresh_token_reuse_rejected", tokenError: "refresh_token_reused", refreshRotationSuccess: false }).catch(() => undefined);
      return sendOAuthError(response, 400, "invalid_grant", "Invalid, expired, or reused refresh token.");
    }
    await client.query("UPDATE refresh_tokens SET consumed_at=NOW(),last_used_at=NOW() WHERE token_hash=$1", [hash]);
    await client.query("UPDATE oauth_grants SET last_used_at=NOW() WHERE grant_id=$1", [token.grant_id]);
    const tokens = await createTokenPair(client, context.config, token, token.family_id, new Date(token.family_expires_at));
    await client.query("COMMIT");
    sendJson(response, 200, tokens);
    log("info", "oauth_refresh_token_rotated", { deviceIdSuffix: token.device_public_id.slice(-6), clientIdSuffix: token.client_id.slice(-6), scopes: token.scopes });
    void updateOAuthDiagnostics(context.database, token.device_public_id, { stage: "refresh_token_rotated", tokenError: null, grantFound: true, refreshRotationSuccess: true }).catch(() => undefined);
  } catch (error) {
    await client.query("ROLLBACK");
    const reason = safeOAuthReason(error);
    log("warn", "oauth_refresh_token_rejected", { reason, clientIdSuffix: clientId.slice(-6), ...(token?.device_public_id ? { deviceIdSuffix: token.device_public_id.slice(-6) } : {}) });
    if (token?.device_public_id) void updateOAuthDiagnostics(context.database, token.device_public_id, { stage: "refresh_token_rejected", tokenError: reason, grantFound: Boolean(token.grant_id), refreshRotationSuccess: false }).catch(() => undefined);
    sendOAuthError(response, 400, "invalid_grant", "Invalid, expired, or reused refresh token.");
  } finally { client.release(); }
}

async function createTokenPair(client: { query: RelayDatabase["query"] }, config: RelayConfig, grant: Record<string, any>, familyId: string, familyExpiresAt = new Date(Date.now() + refreshTokenFamilyTtlMs)) {
  const now = Date.now();
  const refreshToken = randomToken(48);
  await client.query("INSERT INTO refresh_tokens(token_hash,family_id,grant_id,expires_at,family_expires_at) VALUES($1,$2,$3,$4,$5)", [hashSecret(refreshToken, config.tokenSecret), familyId, grant.grant_id, familyExpiresAt, familyExpiresAt]);
  const accessToken = signAccessToken({
    version: 1, devicePublicId: grant.device_public_id, clientId: grant.client_id, grantId: grant.grant_id, grantVersion: grant.token_version,
    scopes: grant.scopes, issuedAt: now, expiresAt: now + accessTokenTtlMs,
    issuer: config.publicOrigin, audience: `${config.publicOrigin}/mcp/${grant.device_public_id}`,
  }, config.signingSecret);
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: accessTokenTtlMs / 1000, scope: (grant.scopes as string[]).join(" ") };
}

async function revokeToken(request: IncomingMessage, response: ServerResponse, context: RouteContext) {
  const form = await readForm(request);
  const raw = form.get("token") ?? "";
  const hash = hashSecret(raw, context.config.tokenSecret);
  const row = (await context.database.query("SELECT grant_id FROM refresh_tokens WHERE token_hash=$1", [hash])).rows[0];
  const access = row ? undefined : verifyAccessTokenDetailed(raw, context.config.signingSecret);
  const grantId = row?.grant_id ?? (access?.ok ? access.claims.grantId : undefined);
  if (grantId) {
    await context.database.query("UPDATE oauth_grants SET revoked_at=NOW(),token_version=token_version+1 WHERE grant_id=$1 AND revoked_at IS NULL", [grantId]);
    await context.database.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE grant_id=$1", [grantId]);
    log("info", "oauth_grant_revoked", { tokenType: row ? "refresh_token" : "access_token" });
  }
  response.writeHead(200).end();
}

async function forwardMcp(request: IncomingMessage, response: ServerResponse, context: RouteContext, devicePublicId: string) {
  const token = bearerToken(request);
  const audience = `${context.config.publicOrigin}/mcp/${devicePublicId}`;
  const verification = token ? verifyAccessTokenDetailed(token, context.config.signingSecret, Date.now(), { issuer: context.config.publicOrigin, audience }) : { ok: false as const, reason: "missing_token" as const };
  if (!verification.ok) {
    log("warn", "mcp_token_rejected", { deviceIdSuffix: devicePublicId.slice(-6), reason: verification.reason });
    void updateOAuthDiagnostics(context.database, devicePublicId, { stage: "mcp_token_rejected", tokenError: verification.reason }).catch(() => undefined);
    return unauthorized(response, context, devicePublicId, verification.reason);
  }
  const claims = verification.claims;
  if (claims.devicePublicId !== devicePublicId) {
    log("warn", "mcp_token_rejected", { deviceIdSuffix: devicePublicId.slice(-6), reason: "device_mismatch" });
    void updateOAuthDiagnostics(context.database, devicePublicId, { stage: "mcp_token_rejected", tokenError: "device_mismatch" }).catch(() => undefined);
    return unauthorized(response, context, devicePublicId, "device_mismatch");
  }
  const grant = (await context.database.query("SELECT g.scopes,g.token_version,d.access_mode FROM oauth_grants g JOIN relay_devices d ON d.device_public_id=g.device_public_id WHERE g.grant_id=$1 AND g.client_id=$2 AND g.device_public_id=$3 AND g.revoked_at IS NULL AND d.revoked_at IS NULL", [claims.grantId, claims.clientId, devicePublicId])).rows[0];
  if (!grant || grant.token_version !== claims.grantVersion) {
    log("warn", "mcp_token_rejected", { deviceIdSuffix: devicePublicId.slice(-6), clientIdSuffix: claims.clientId.slice(-6), reason: grant ? "grant_version_mismatch" : "grant_missing" });
    void updateOAuthDiagnostics(context.database, devicePublicId, { stage: "mcp_token_rejected", tokenError: grant ? "grant_version_mismatch" : "grant_missing", grantFound: Boolean(grant) }).catch(() => undefined);
    return unauthorized(response, context, devicePublicId, grant ? "grant_version_mismatch" : "grant_missing");
  }
  const payload = await readJson(request);
  const id = isRecord(payload) && (typeof payload.id === "string" || typeof payload.id === "number") ? payload.id : null;
  const requiredScope = requiredScopeForMcpPayload(payload);
  if (!claims.scopes.includes(requiredScope) || !(grant.scopes as string[]).includes(requiredScope)) {
    log("warn", "mcp_scope_rejected", { deviceIdSuffix: devicePublicId.slice(-6), clientIdSuffix: claims.clientId.slice(-6), requiredScope });
    void updateOAuthDiagnostics(context.database, devicePublicId, { stage: "mcp_scope_rejected", tokenError: "insufficient_scope", grantFound: true }).catch(() => undefined);
    return insufficientScope(response, requiredScope);
  }
  if (!context.hub.isOnline(devicePublicId)) return sendJson(response, 503, rpcError(id, -32004, "Aevum device is offline."));
  try {
    const allowedNow = scopesForMode(accessModeSchema.parse(grant.access_mode));
    const effectiveScopes = claims.scopes.filter((scope) => allowedNow.includes(scope) && (grant.scopes as string[]).includes(scope));
    await context.database.query("UPDATE oauth_grants SET last_used_at=NOW() WHERE grant_id=$1", [claims.grantId]);
    log("info", "mcp_token_accepted", { deviceIdSuffix: devicePublicId.slice(-6), clientIdSuffix: claims.clientId.slice(-6), scopes: effectiveScopes });
    void updateOAuthDiagnostics(context.database, devicePublicId, { stage: "mcp_token_accepted", tokenError: null, grantFound: true }).catch(() => undefined);
    const result = await context.hub.requestMcp(devicePublicId, effectiveScopes, payload);
    sendJson(response, 200, result);
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    sendJson(response, timedOut ? 504 : 503, rpcError(id, timedOut ? -32005 : -32004, timedOut ? "Aevum did not respond in time." : "Aevum device is offline."));
  }
}

class DeviceHub {
  private readonly devices = new Map<string, DeviceConnection>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(private readonly config: RelayConfig, private readonly database: RelayDatabase) {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 25_000);
    this.heartbeatTimer.unref();
  }

  accept(socket: WebSocket) {
    log("info", "device_connect_attempt");
    let connection: DeviceConnection | undefined;
    const authTimer = setTimeout(() => socket.close(4401, "Device authentication timed out"), 10_000);
    socket.on("pong", () => { if (connection) connection.alive = true; });
    socket.on("message", async (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return this.send(socket, { type: "error", code: "invalid_json", message: "Malformed relay message." }); }
      const validation = desktopMessageSchema.safeParse(parsed);
      if (!validation.success) return this.send(socket, { type: "error", code: "invalid_message", message: "Invalid relay message." });
      const message = validation.data;
      if (!connection) {
        if (message.type !== "device_register") return socket.close(4401, "Authentication required");
        connection = await this.authenticate(socket, message).catch((error) => {
          log("warn", "device_auth_failed", { deviceIdSuffix: message.devicePublicId.slice(-6), error: safeError(error) });
          return undefined;
        });
        if (!connection) return socket.close(4403, "Device authentication failed");
        clearTimeout(authTimer);
        return;
      }
      if (message.type === "heartbeat") {
        connection.alive = true;
        void this.database.query("UPDATE relay_devices SET last_seen_at=NOW() WHERE device_public_id=$1", [connection.devicePublicId]);
        return this.send(socket, { type: "heartbeat", sentAt: new Date().toISOString() });
      }
      if (message.type === "mcp_response" || message.type === "oauth_approval_result") this.resolvePending(message.requestId, connection.devicePublicId, message.type === "mcp_response" && message.error ? new Error(message.error.code) : message.type === "mcp_response" ? message.payload : message.approved);
      if (message.type === "device_reset") await this.resetDevice(connection.devicePublicId);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (connection && this.devices.get(connection.devicePublicId)?.socket === socket) this.devices.delete(connection.devicePublicId);
      if (connection) this.rejectDevicePending(connection.devicePublicId, "offline");
      if (connection) log("info", "device_disconnected", { deviceIdSuffix: connection.devicePublicId.slice(-6) });
    });
    socket.on("error", () => undefined);
  }

  private async authenticate(socket: WebSocket, message: Extract<import("./protocol.js").DesktopMessage, { type: "device_register" }>) {
    const result = await this.database.query("SELECT * FROM relay_devices WHERE device_public_id=$1", [message.devicePublicId]);
    const existing = result.rows[0];
    const secretHash = hashSecret(message.deviceSecret, this.config.tokenSecret);
    if (existing && (existing.revoked_at || !safeHashEqual(message.deviceSecret, existing.device_secret_hash, this.config.tokenSecret))) throw new Error("invalid_device");
    if (!existing) await this.database.query("INSERT INTO relay_devices(device_public_id,device_secret_hash,access_mode) VALUES($1,$2,$3)", [message.devicePublicId, secretHash, message.accessMode]);
    else {
      if (existing.access_mode !== message.accessMode && isAccessModeExpansion(accessModeSchema.parse(existing.access_mode), message.accessMode)) {
        await this.database.query("UPDATE oauth_grants SET revoked_at=NOW(),token_version=token_version+1 WHERE device_public_id=$1 AND revoked_at IS NULL", [message.devicePublicId]);
        await this.database.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE grant_id IN (SELECT grant_id FROM oauth_grants WHERE device_public_id=$1)", [message.devicePublicId]);
        log("info", "oauth_grants_invalidated", { deviceIdSuffix: message.devicePublicId.slice(-6), reason: "access_mode_expanded", previousMode: existing.access_mode, nextMode: message.accessMode });
      } else if (existing.access_mode !== message.accessMode) {
        const reducedScopes = scopesForMode(message.accessMode);
        await this.database.query("UPDATE oauth_grants SET scopes=$2::jsonb WHERE device_public_id=$1 AND revoked_at IS NULL", [message.devicePublicId, JSON.stringify(reducedScopes)]);
      }
      await this.database.query("UPDATE relay_devices SET access_mode=$2,last_seen_at=NOW() WHERE device_public_id=$1", [message.devicePublicId, message.accessMode]);
    }
    const previous = this.devices.get(message.devicePublicId);
    if (existing) log("info", "device_reconnect", { deviceIdSuffix: message.devicePublicId.slice(-6) });
    if (previous && previous.socket !== socket) previous.socket.close(4409, "Replaced by a newer device connection");
    const connection = { socket, devicePublicId: message.devicePublicId, accessMode: message.accessMode, alive: true };
    this.devices.set(message.devicePublicId, connection);
    this.send(socket, { type: "device_ready", devicePublicId: message.devicePublicId, connectorUrl: `${this.config.publicOrigin}/mcp/${message.devicePublicId}`, heartbeatIntervalMs: 25_000 });
    log("info", "device_connected", { deviceIdSuffix: message.devicePublicId.slice(-6), accessMode: message.accessMode });
    return connection;
  }

  isOnline(devicePublicId: string) { return this.devices.get(devicePublicId)?.socket.readyState === WebSocket.OPEN; }

  requestMcp(devicePublicId: string, scopes: string[], payload: unknown) {
    return this.request(devicePublicId, mcpTimeoutMs, (requestId) => ({ type: "mcp_request", requestId, devicePublicId, timeoutMs: mcpTimeoutMs, scopes, payload }));
  }

  requestApproval(devicePublicId: string, input: { clientName: string; redirectUri: string; scopes: string[] }) {
    return this.request(devicePublicId, approvalTimeoutMs, (requestId) => ({ type: "oauth_approval_request", requestId, devicePublicId, timeoutMs: approvalTimeoutMs, ...input })) as Promise<boolean>;
  }

  notifyClientRevoked(devicePublicId: string, clientId?: string) {
    this.send(this.devices.get(devicePublicId)?.socket, { type: "client_revoked", devicePublicId, clientId });
  }

  private request(devicePublicId: string, timeoutMs: number, create: (requestId: string) => RelayMessage) {
    const connection = this.devices.get(devicePublicId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("offline"));
    const requestId = randomToken(24);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("timeout")); }, timeoutMs);
      this.pending.set(requestId, { devicePublicId, timer, resolve, reject });
      this.send(connection.socket, create(requestId));
    });
  }

  private resolvePending(requestId: string, devicePublicId: string, value: unknown) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.devicePublicId !== devicePublicId) return;
    this.pending.delete(requestId); clearTimeout(pending.timer);
    value instanceof Error ? pending.reject(value) : pending.resolve(value);
  }

  private rejectDevicePending(devicePublicId: string, reason: string) {
    for (const [id, pending] of this.pending) if (pending.devicePublicId === devicePublicId) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error(reason)); }
  }

  private heartbeat() {
    for (const connection of this.devices.values()) {
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false; connection.socket.ping();
    }
  }

  async resetDevice(devicePublicId: string) {
    await this.database.query("UPDATE relay_devices SET revoked_at=NOW() WHERE device_public_id=$1", [devicePublicId]);
    await this.database.query("UPDATE oauth_grants SET revoked_at=NOW() WHERE device_public_id=$1", [devicePublicId]);
    const connection = this.devices.get(devicePublicId);
    this.send(connection?.socket, { type: "device_reset", devicePublicId });
    connection?.socket.close(4403, "Device identity reset");
  }

  close() {
    clearInterval(this.heartbeatTimer);
    for (const connection of this.devices.values()) connection.socket.close(1012, "Relay restarting");
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("shutdown")); }
    this.pending.clear(); this.devices.clear();
  }

  private send(socket: WebSocket | undefined, message: RelayMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

async function updateOAuthDiagnostics(database: RelayDatabase, devicePublicId: string, value: { stage?: string; tokenError?: string | null; grantFound?: boolean; refreshRotationSuccess?: boolean }) {
  await database.query(
    `INSERT INTO oauth_diagnostics(device_public_id,last_oauth_stage,last_token_error,grant_found,last_refresh_rotation_success)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(device_public_id) DO UPDATE SET
       last_oauth_stage=COALESCE(EXCLUDED.last_oauth_stage,oauth_diagnostics.last_oauth_stage),
       last_token_error=EXCLUDED.last_token_error,
       grant_found=COALESCE(EXCLUDED.grant_found,oauth_diagnostics.grant_found),
       last_refresh_rotation_success=COALESCE(EXCLUDED.last_refresh_rotation_success,oauth_diagnostics.last_refresh_rotation_success),updated_at=NOW()`,
    [devicePublicId, value.stage ?? null, value.tokenError ?? null, value.grantFound ?? null, value.refreshRotationSuccess ?? null],
  );
}

async function getActiveDevice(database: RelayDatabase, devicePublicId: string) {
  return (await database.query("SELECT device_public_id,access_mode FROM relay_devices WHERE device_public_id=$1 AND revoked_at IS NULL", [devicePublicId])).rows[0] as { device_public_id: string; access_mode: AccessMode } | undefined;
}

function unauthorized(response: ServerResponse, context: RouteContext, devicePublicId: string, reason = "invalid_token") {
  response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${context.config.publicOrigin}/.well-known/oauth-protected-resource/mcp/${devicePublicId}", error="invalid_token"`);
  sendJson(response, 401, { error: "invalid_token", error_description: "The access token is invalid or expired.", reason });
}

function insufficientScope(response: ServerResponse, requiredScope: string) {
  response.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${requiredScope}"`);
  sendJson(response, 403, { error: "insufficient_scope", error_description: `The ${requiredScope} scope is required.` });
}

const proposalTools = new Set(["propose_task_changes", "start_full_agent_workflow"]);
const writeTools = new Set(["create_tasks", "update_task", "reschedule_task", "set_task_status", "delete_task", "assign_task_to_category", "create_category", "rename_category"]);
function requiredScopeForMcpPayload(payload: unknown) {
  if (!isRecord(payload) || payload.method !== "tools/call" || !isRecord(payload.params) || typeof payload.params.name !== "string") return "mcp:read";
  if (writeTools.has(payload.params.name)) return "mcp:write";
  if (proposalTools.has(payload.params.name)) return "mcp:propose";
  return "mcp:read";
}

function rpcError(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function bearerToken(request: IncomingMessage) { const value = request.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7) : undefined; }
function firstHeader(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function safePath(value: string | undefined) {
  try {
    return new URL(value ?? "/", "http://relay").pathname
      .replace(/^\/mcp\/[^/]+$/, "/mcp/:devicePublicId")
      .replace(/^\/device\/[^/]+\/clients\/[^/]+$/, "/device/:devicePublicId/clients/:clientId")
      .replace(/^\/device\/[^/]+\/clients$/, "/device/:devicePublicId/clients")
      .replace(/^\/device\/[^/]+$/, "/device/:devicePublicId")
      .replace(/^\/oauth\/session\/[^/]+\/status$/, "/oauth/session/:sessionId/status")
      .replace(/^\/\.well-known\/oauth-protected-resource\/mcp\/[^/]+$/, "/.well-known/oauth-protected-resource/mcp/:devicePublicId");
  } catch { return "/"; }
}
function safeError(error: unknown) { return error instanceof Error ? error.name : "unknown"; }
function safeOAuthReason(error: unknown) {
  if (!(error instanceof Error)) return "invalid_grant";
  return ["invalid_grant", "refresh_token_missing", "client_mismatch", "grant_revoked", "refresh_token_expired"].includes(error.message) ? error.message : "invalid_grant";
}
function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) { process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSafeRedirectUri(value: unknown) { if (typeof value !== "string") return false; try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; } }

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > maxHttpBodyBytes) throw new Error("request_too_large"); chunks.push(buffer); }
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(request: IncomingMessage) { const body = await readBody(request); try { return JSON.parse(body || "{}"); } catch { throw new Error("invalid_json"); } }
async function readForm(request: IncomingMessage) { return new URLSearchParams(await readBody(request)); }
function sendJson(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value)); }
function sendHtml(response: ServerResponse, status: number, value: string) { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" }).end(value); }
function sendOAuthError(response: ServerResponse, status: number, error: string, description: string) { sendJson(response, status, { error, error_description: description }); }
function redirectOAuthError(response: ServerResponse, redirectUri: string, state: string | null, error: string) { response.writeHead(302, { Location: oauthRedirect(redirectUri, state, { error }) }).end(); }
function redirectWithCode(response: ServerResponse, redirectUri: string, state: string | null, code: string) { response.writeHead(302, { Location: oauthRedirect(redirectUri, state, { code }) }).end(); }
function oauthRedirect(redirectUri: string, state: string | null, values: Record<string, string>) { const url = new URL(redirectUri); for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value); if (state) url.searchParams.set("state", state); return url.href; }
function renderConsent(input: { sessionId: string; clientName: string; scopes: string[]; action: string }) { const permission = input.scopes.includes("mcp:write") ? "Full Access productivity tools (writes still require confirmation in Aevum)." : input.scopes.includes("mcp:propose") ? "Read data and create proposals." : "Read sanitized Aevum data."; return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Aevum Connect</title><style>${pageStyle()}</style><main><h1>Connect ${escapeHtml(input.clientName)}?</h1><p>${escapeHtml(permission)}</p><p>Requested scopes: ${escapeHtml(input.scopes.join(" "))}</p><form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="consent_id" value="${escapeHtml(input.sessionId)}"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Continue in Aevum</button></form></main>`; }
function renderWaiting(statusUrl: string) { const endpoint = JSON.stringify(statusUrl).replace(/</g, "\\u003c"); return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Waiting for Aevum</title><style>${pageStyle()}</style><main><h1>Approve in Aevum</h1><p id="status">Waiting for the desktop app…</p></main><script>const u=${endpoint},s=document.getElementById('status');async function p(){try{const r=await fetch(u,{cache:'no-store'}),d=await r.json();if(d.redirectUrl)return location.replace(d.redirectUrl);if(d.error)return s.textContent=d.error}catch{}setTimeout(p,750)}p()</script>`; }
function pageStyle() { return `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e11;color:#f4f1ea;font:15px system-ui}main{width:min(440px,calc(100% - 48px));padding:28px;border:1px solid #34343d;border-radius:18px;background:#19191e}h1{font-size:22px}p{color:#bbb7ae;line-height:1.5}form{display:flex;gap:10px;margin-top:22px}button{flex:1;padding:11px;border:0;border-radius:10px;background:#303038;color:#eee;font-weight:650}.primary{background:#d7b56d;color:#17130b}`; }
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char); }

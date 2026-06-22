import type { Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const authorizationTtlMs = 10 * 60_000;
const terminalSessionTtlMs = 2 * 60_000;
const codeTtlMs = 2 * 60_000;
const accessTokenTtlSeconds = 15 * 60;
const refreshTokenTtlMs = 30 * 24 * 60 * 60_000;

export type OAuthAuthorizationStage =
  | "pending_browser_consent"
  | "pending_native_approval"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export type OAuthDiagnostics = {
  currentStage?: OAuthAuthorizationStage;
  activeSessionCount: number;
  registeredClientCount: number;
  activeGrantCount: number;
  lastGrantedScopes?: string[];
  lastError?: string;
  lastRedirectStatus?: string;
};

type AuthorizationSession = {
  id: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  stage: OAuthAuthorizationStage;
  expiresAt: number;
  purgeAt?: number;
  redirectUrl?: string;
  authorizationCode?: string;
  updatedAt: number;
};

type AuthorizationCode = {
  code: string;
  sessionId: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
};

type TokenRecord = {
  clientId: string;
  scopes: string[];
  resource: URL;
  expiresAt: number;
};

export class AevumOAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & Partial<Pick<OAuthClientInformationFull, "client_id" | "client_id_issued_at">>) {
    const normalized: OAuthClientInformationFull = {
      ...client,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
    };
    this.clients.set(normalized.client_id, normalized);
    return normalized;
  }

  get size() {
    return this.clients.size;
  }
}

export class AevumOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new AevumOAuthClientsStore();
  private readonly sessions = new Map<string, AuthorizationSession>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();
  private lastError = "";
  private lastRedirectStatus = "";
  private lastGrantedScopes: string[] = [];

  constructor(
    private readonly publicBaseUrl: URL,
    private readonly allowedScopes: () => string[],
    private readonly confirmLocally: (request: { clientName: string; redirectUri: string; scopes: string[] }) => Promise<boolean>,
    private readonly onDiagnostics: (diagnostics: OAuthDiagnostics) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response) {
    this.cleanup();
    const scopes = this.validateScopes(params.scopes);
    const resource = this.validateResource(params.resource);
    const sessionId = randomBytes(32).toString("base64url");
    const now = this.now();
    this.sessions.set(sessionId, {
      id: sessionId,
      client,
      params: { ...params, scopes, resource },
      stage: "pending_browser_consent",
      expiresAt: now + authorizationTtlMs,
      updatedAt: now,
    });
    this.lastError = "";
    this.lastRedirectStatus = "Waiting for browser consent.";
    this.publishDiagnostics();
    response.status(200)
      .set(browserSecurityHeaders("form"))
      .type("html")
      .send(renderConsentPage({
        sessionId,
        clientName: client.client_name ?? "ChatGPT MCP connector",
        redirectUri: params.redirectUri,
        scopes,
        approvalUrl: new URL("/oauth/decision", this.publicBaseUrl).href,
      }));
  }

  async resolveConsent(sessionId: string, decision: "approve" | "deny", response: Response) {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    if (!session || session.stage !== "pending_browser_consent") {
      this.lastError = "Authorization session is invalid, expired, or already handled.";
      this.publishDiagnostics();
      response.status(400).set(browserSecurityHeaders("none")).type("text").send("This authorization request is invalid or expired.");
      return;
    }

    if (decision !== "approve") {
      this.finishDenied(session, "The Aevum user denied this connection.");
      response.redirect(302, session.redirectUrl!);
      return;
    }

    session.stage = "pending_native_approval";
    session.updatedAt = this.now();
    this.lastRedirectStatus = "Waiting for approval in the local Aevum app.";
    this.publishDiagnostics();
    response.status(200)
      .set(browserSecurityHeaders("poll"))
      .type("html")
      .send(renderWaitingPage({
        statusUrl: new URL(`/oauth/session/${encodeURIComponent(session.id)}/status`, this.publicBaseUrl).href,
      }));
    void this.completeNativeApproval(session.id);
  }

  getAuthorizationStatus(sessionId: string) {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.lastError = "Authorization session is invalid or expired.";
      this.publishDiagnostics();
      return { stage: "expired" as const, error: "Authorization session is invalid or expired." };
    }
    if ((session.stage === "approved" || session.stage === "denied" || session.stage === "expired") && session.redirectUrl) {
      this.lastRedirectStatus = session.stage === "approved" ? "Authorization redirect is ready." : `${session.stage} redirect is ready.`;
      this.publishDiagnostics();
      return { stage: session.stage, redirectUrl: session.redirectUrl };
    }
    return { stage: session.stage };
  }

  getDiagnostics(): OAuthDiagnostics {
    this.cleanup(false);
    const sessions = [...this.sessions.values()];
    const current = sessions.sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return {
      currentStage: current?.stage,
      activeSessionCount: sessions.filter((session) => ["pending_browser_consent", "pending_native_approval", "approved"].includes(session.stage)).length,
      registeredClientCount: this.clientsStore.size,
      activeGrantCount: this.refreshTokens.size,
      lastGrantedScopes: this.lastGrantedScopes.length ? [...this.lastGrantedScopes] : undefined,
      lastError: this.lastError || undefined,
      lastRedirectStatus: this.lastRedirectStatus || undefined,
    };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string) {
    return this.getValidCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const code = this.getValidCode(client, authorizationCode);
    if (!redirectUri || redirectUri !== code.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    const expectedResource = this.validateResource(code.params.resource);
    if (resource && resource.href !== expectedResource.href) throw new InvalidTargetError("Invalid MCP resource.");
    this.codes.delete(authorizationCode);
    const session = this.sessions.get(code.sessionId);
    if (session) {
      session.stage = "consumed";
      session.authorizationCode = undefined;
      session.updatedAt = this.now();
      session.purgeAt = this.now() + terminalSessionTtlMs;
    }
    this.lastRedirectStatus = "Authorization code consumed successfully.";
    this.publishDiagnostics();
    return this.issueTokens(client.client_id, code.params.scopes ?? [], expectedResource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.cleanup();
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id || record.expiresAt <= this.now()) throw new InvalidGrantError("Invalid or expired refresh token.");
    const nextScopes = scopes?.length ? this.validateScopes(scopes) : record.scopes;
    if (nextScopes.some((scope) => !record.scopes.includes(scope))) throw new InvalidScopeError("Refresh scope exceeds the original grant.");
    if (resource && resource.href !== record.resource.href) throw new InvalidTargetError("Invalid MCP resource.");
    this.refreshTokens.delete(refreshToken);
    return this.issueTokens(client.client_id, nextScopes, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.cleanup();
    const record = this.accessTokens.get(token);
    if (!record || record.expiresAt <= this.now()) throw new AccessDeniedError("Invalid or expired access token.");
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: Math.floor(record.expiresAt / 1000), resource: record.resource };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const access = this.accessTokens.get(request.token);
    if (access?.clientId === client.client_id) this.accessTokens.delete(request.token);
    const refresh = this.refreshTokens.get(request.token);
    if (refresh?.clientId === client.client_id) this.refreshTokens.delete(request.token);
    this.publishDiagnostics();
  }

  private async completeNativeApproval(sessionId: string) {
    const initial = this.sessions.get(sessionId);
    if (!initial || initial.stage !== "pending_native_approval") return;
    let approved = false;
    try {
      approved = await this.confirmLocally({
        clientName: initial.client.client_name ?? "ChatGPT MCP connector",
        redirectUri: initial.params.redirectUri,
        scopes: initial.params.scopes ?? [],
      });
    } catch {
      this.lastError = "The local Aevum approval dialog failed.";
    }

    this.cleanup();
    const session = this.sessions.get(sessionId);
    if (!session || session.stage !== "pending_native_approval") return;
    if (!approved) {
      this.finishDenied(session, "The Aevum user denied this connection.");
      return;
    }

    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + codeTtlMs;
    this.codes.set(code, { code, sessionId, client: session.client, params: session.params, expiresAt });
    session.authorizationCode = code;
    session.stage = "approved";
    session.expiresAt = expiresAt;
    session.updatedAt = this.now();
    session.redirectUrl = this.createRedirect(session, { code });
    this.lastError = "";
    this.lastRedirectStatus = "Native approval completed; browser redirect is ready.";
    this.publishDiagnostics();
  }

  private finishDenied(session: AuthorizationSession, description: string) {
    session.stage = "denied";
    session.updatedAt = this.now();
    session.purgeAt = this.now() + terminalSessionTtlMs;
    session.redirectUrl = this.createRedirect(session, { error: "access_denied", error_description: description });
    this.lastRedirectStatus = "Authorization denied; browser redirect is ready.";
    this.publishDiagnostics();
  }

  private expireSession(session: AuthorizationSession) {
    if (session.authorizationCode) this.codes.delete(session.authorizationCode);
    session.authorizationCode = undefined;
    session.stage = "expired";
    session.updatedAt = this.now();
    session.purgeAt = this.now() + terminalSessionTtlMs;
    session.redirectUrl = this.createRedirect(session, { error: "access_denied", error_description: "The Aevum authorization request expired." });
    this.lastError = "Authorization session expired before completion.";
    this.lastRedirectStatus = "Expired authorization redirect is ready.";
  }

  private createRedirect(session: AuthorizationSession, values: Record<string, string>) {
    const target = new URL(session.params.redirectUri);
    for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
    if (session.params.state) target.searchParams.set("state", session.params.state);
    return target.href;
  }

  private issueTokens(clientId: string, scopes: string[], resource: URL): OAuthTokens {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    this.accessTokens.set(accessToken, { clientId, scopes, resource, expiresAt: this.now() + accessTokenTtlSeconds * 1000 });
    this.refreshTokens.set(refreshToken, { clientId, scopes, resource, expiresAt: this.now() + refreshTokenTtlMs });
    this.lastGrantedScopes = [...scopes];
    this.publishDiagnostics();
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: accessTokenTtlSeconds, scope: scopes.join(" ") };
  }

  private getValidCode(client: OAuthClientInformationFull, authorizationCode: string) {
    this.cleanup();
    const code = this.codes.get(authorizationCode);
    if (!code || code.client.client_id !== client.client_id || code.expiresAt <= this.now()) {
      this.lastError = "Authorization code is invalid, expired, or already consumed.";
      this.publishDiagnostics();
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return code;
  }

  private validateScopes(requested: string[] | undefined) {
    const allowed = this.allowedScopes();
    const scopes = requested?.length ? [...new Set(requested)] : allowed;
    if (scopes.some((scope) => !allowed.includes(scope))) throw new InvalidScopeError("Requested scope is not available.");
    return scopes;
  }

  private validateResource(resource: URL | undefined) {
    const expected = new URL("/mcp", this.publicBaseUrl);
    if (resource && resource.href !== expected.href) throw new InvalidTargetError("Invalid MCP resource.");
    return expected;
  }

  private cleanup(publish = true) {
    const now = this.now();
    let changed = false;
    for (const session of this.sessions.values()) {
      if (["pending_browser_consent", "pending_native_approval", "approved"].includes(session.stage) && session.expiresAt <= now) {
        this.expireSession(session);
        changed = true;
      }
      if (session.purgeAt && session.purgeAt <= now) {
        this.sessions.delete(session.id);
        changed = true;
      }
    }
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    for (const [key, value] of this.accessTokens) if (value.expiresAt <= now) { this.accessTokens.delete(key); changed = true; }
    for (const [key, value] of this.refreshTokens) if (value.expiresAt <= now) { this.refreshTokens.delete(key); changed = true; }
    if (changed && publish) this.publishDiagnostics();
  }

  private publishDiagnostics() {
    this.onDiagnostics(this.getDiagnostics());
  }
}

function browserSecurityHeaders(mode: "form" | "poll" | "none") {
  const csp = mode === "form"
    ? "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    : mode === "poll"
      ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
      : "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  return { "Cache-Control": "no-store", "Content-Security-Policy": csp, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
}

function renderConsentPage(input: { sessionId: string; clientName: string; redirectUri: string; scopes: string[]; approvalUrl: string }) {
  const permissions = input.scopes.includes("mcp:write")
    ? "Full Access: read sanitized Aevum data and use productivity tools. Every write still creates an in-app proposal for confirmation."
    : input.scopes.includes("mcp:propose")
    ? "Read sanitized Aevum data and send task proposals for confirmation."
    : "Read sanitized Aevum task, category, and activity data.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Aevum MCP</title>${pageStyles()}</head><body><main class="panel"><h1>Connect ${escapeHtml(input.clientName)} to Aevum?</h1><p>${escapeHtml(permissions)}</p><div class="meta"><strong>Redirect:</strong><br>${escapeHtml(input.redirectUri)}</div><p>Authorization also requires confirmation in the local Aevum app. Changes are never applied directly.</p><form class="actions" method="post" action="${escapeHtml(input.approvalUrl)}"><input type="hidden" name="consent_id" value="${escapeHtml(input.sessionId)}"><button class="deny" name="decision" value="deny">Deny</button><button class="approve" name="decision" value="approve">Authorize</button></form></main></body></html>`;
}

function renderWaitingPage(input: { statusUrl: string }) {
  const statusUrl = JSON.stringify(input.statusUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waiting for Aevum</title>${pageStyles()}</head><body><main class="panel"><h1>Confirm in Aevum</h1><p id="status">Waiting for approval in the local Aevum app…</p><p>This page will return to ChatGPT automatically.</p></main><script>const endpoint=${statusUrl};const label=document.getElementById("status");async function poll(){try{const response=await fetch(endpoint,{cache:"no-store",credentials:"omit"});const data=await response.json();if(data.redirectUrl){window.location.replace(data.redirectUrl);return}if(data.error){label.textContent=data.error;return}}catch{}setTimeout(poll,750)}poll();</script></body></html>`;
}

function pageStyles() {
  return `<style>body{margin:0;background:#0c0c0f;color:#f4f1ea;font:15px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.panel{width:min(440px,calc(100% - 40px));padding:28px;border:1px solid #34343d;border-radius:18px;background:#17171c;box-shadow:0 24px 80px #0008}h1{font-size:21px;margin:0 0 10px}p{color:#b9b6ae;line-height:1.5}.meta{padding:12px;border-radius:10px;background:#202027;font-size:13px;overflow-wrap:anywhere}.actions{display:flex;gap:10px;margin-top:22px}button{flex:1;padding:11px;border:0;border-radius:10px;font-weight:650;cursor:pointer}.approve{background:#d7b56d;color:#17130b}.deny{background:#303038;color:#eee}</style>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

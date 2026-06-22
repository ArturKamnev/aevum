import { describe, expect, it } from "vitest";
import { AevumOAuthProvider } from "./mcpOAuthProvider";

describe("Aevum OAuth authorization state machine", () => {
  it("keeps browser consent pending, waits for native approval, then redirects and consumes once", async () => {
    let approve!: (value: boolean) => void;
    const nativeApproval = new Promise<boolean>((resolve) => { approve = resolve; });
    const provider = createProvider(() => nativeApproval);
    const { client, params } = register(provider);
    const consent = responseMock();
    await provider.authorize(client, params, consent as never);
    const sessionId = consent.body.match(/name="consent_id" value="([^"]+)"/)?.[1];
    expect(sessionId).toBeTruthy();
    expect(provider.getDiagnostics()).toMatchObject({ currentStage: "pending_browser_consent", activeSessionCount: 1 });

    const waiting = responseMock();
    await provider.resolveConsent(sessionId!, "approve", waiting as never);
    expect(waiting.statusCode).toBe(200);
    expect(waiting.body).toContain("This page will return to ChatGPT automatically");
    expect(provider.getAuthorizationStatus(sessionId!)).toEqual({ stage: "pending_native_approval" });

    approve(true);
    await Promise.resolve();
    await Promise.resolve();
    const approved = provider.getAuthorizationStatus(sessionId!);
    expect(approved.stage).toBe("approved");
    const callback = new URL(approved.redirectUrl!);
    const code = callback.searchParams.get("code")!;
    expect(callback.searchParams.get("state")).toBe("original-state");
    await provider.exchangeAuthorizationCode(client, code, "verifier", params.redirectUri, params.resource);
    expect(provider.getAuthorizationStatus(sessionId!).stage).toBe("consumed");
    await expect(provider.exchangeAuthorizationCode(client, code, "verifier", params.redirectUri, params.resource)).rejects.toThrow();
  });

  it("redirects denials with the original state", async () => {
    const provider = createProvider(async () => false);
    const { client, params } = register(provider);
    const consent = responseMock();
    await provider.authorize(client, params, consent as never);
    const sessionId = consent.body.match(/name="consent_id" value="([^"]+)"/)?.[1]!;
    const denied = responseMock();
    await provider.resolveConsent(sessionId, "deny", denied as never);
    const callback = new URL(denied.redirectUrl);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("original-state");
  });

  it("turns expired sessions into a redirect instead of leaving the browser waiting", async () => {
    let now = 1_000;
    const provider = createProvider(async () => true, () => now);
    const { client, params } = register(provider);
    const consent = responseMock();
    await provider.authorize(client, params, consent as never);
    const sessionId = consent.body.match(/name="consent_id" value="([^"]+)"/)?.[1]!;
    now += 11 * 60_000;
    const expired = provider.getAuthorizationStatus(sessionId);
    expect(expired.stage).toBe("expired");
    expect(new URL(expired.redirectUrl!).searchParams.get("error")).toBe("access_denied");
  });

  it("defaults a scope-less Full Access authorization to all allowed scopes", async () => {
    const provider = new AevumOAuthProvider(
      new URL("https://aevum-test.trycloudflare.com"),
      () => ["mcp:read", "mcp:propose", "mcp:write"],
      async () => true,
    );
    const { client, params } = register(provider);
    const consent = responseMock();
    await provider.authorize(client, { ...params, scopes: undefined }, consent as never);
    expect(consent.body).toContain("Full Access");
    const sessionId = consent.body.match(/name="consent_id" value="([^"]+)"/)?.[1]!;
    const waiting = responseMock();
    await provider.resolveConsent(sessionId, "approve", waiting as never);
    await Promise.resolve();
    await Promise.resolve();
    const callback = new URL(provider.getAuthorizationStatus(sessionId).redirectUrl!);
    const tokens = await provider.exchangeAuthorizationCode(client, callback.searchParams.get("code")!, "verifier", params.redirectUri, params.resource);
    expect(tokens.scope).toBe("mcp:read mcp:propose mcp:write");
    expect(provider.getDiagnostics()).toMatchObject({
      registeredClientCount: 1,
      activeGrantCount: 1,
      lastGrantedScopes: ["mcp:read", "mcp:propose", "mcp:write"],
    });
  });
});

function createProvider(confirm: () => Promise<boolean>, now: () => number = Date.now) {
  return new AevumOAuthProvider(new URL("https://aevum-test.trycloudflare.com"), () => ["mcp:read"], confirm, () => undefined, now);
}

function register(provider: AevumOAuthProvider) {
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const client = provider.clientsStore.registerClient({
    client_name: "ChatGPT",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  });
  const params = {
    redirectUri,
    codeChallenge: "challenge",
    scopes: ["mcp:read"],
    state: "original-state",
    resource: new URL("https://aevum-test.trycloudflare.com/mcp"),
  };
  return { client, params };
}

function responseMock() {
  return {
    statusCode: 200,
    body: "",
    redirectUrl: "",
    status(code: number) { this.statusCode = code; return this; },
    set() { return this; },
    setHeader() { return this; },
    type() { return this; },
    send(body: string) { this.body = body; return this; },
    redirect(code: number, url: string) { this.statusCode = code; this.redirectUrl = url; return this; },
  };
}

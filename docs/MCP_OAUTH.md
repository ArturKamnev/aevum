# Aevum MCP OAuth (Beta)

Aevum's remote MCP mode is designed for an HTTPS reverse tunnel whose public origin forwards to the loopback MCP listener. The listener remains bound to `127.0.0.1`; do not reconfigure it to listen on a LAN or public interface.

## Cloudflare Tunnel

Forward one HTTPS hostname directly to Aevum's local listener, for example:

```yaml
ingress:
  - hostname: aevum.example.com
    service: http://127.0.0.1:3847
  - service: http_status:404
```

In Aevum Settings:

1. Select **OAuth for remote connector**.
2. Enter the public origin only, such as `https://aevum.example.com` (no `/mcp` path).
3. Choose read-only, proposal, or Full Access.
4. Enable the MCP server explicitly.

Alternatively, choose **Temporary tunnel**. Aevum looks for `cloudflared` in `PATH`, starts a Cloudflare Quick Tunnel without a terminal window, and displays the generated connector URL. Aevum never installs or downloads `cloudflared` automatically.

Quick Tunnel URLs are temporary. The random `trycloudflare.com` hostname may change whenever Aevum or the tunnel restarts, so the ChatGPT connector may need to be updated or recreated. Choose **Persistent tunnel / Stable URL** and provide a named Cloudflare Tunnel hostname, user-owned domain, or another stable HTTPS reverse-tunnel origin for a persistent connector URL. Aevum does not create or reserve tunnel hostnames.

In the ChatGPT custom connector, use `https://aevum.example.com/mcp`. Aevum publishes OAuth discovery metadata, so no bearer token or client secret is entered in ChatGPT. The browser consent step must also be approved in the local Aevum desktop dialog.

## Endpoints

- MCP resource: `/mcp`
- Protected-resource metadata: `/.well-known/oauth-protected-resource/mcp` (and root fallback `/.well-known/oauth-protected-resource`)
- Authorization-server metadata: `/.well-known/oauth-authorization-server`
- Dynamic client registration: `/register`
- Authorization: `/authorize`
- Local confirmation submission: `/oauth/decision`
- Authorization completion polling: `/oauth/session/:sessionId/status`
- Token: `/token`
- Revocation: `/revoke`

The flow uses authorization code with S256 PKCE. Access tokens are opaque and use `mcp:read`, `mcp:propose`, and—only in Full Access—`mcp:write`. They expire after 15 minutes. Refresh tokens rotate when used. OAuth grants are kept only in memory and are invalidated when Aevum, the MCP service, or its access mode restarts; reconnect ChatGPT after changing permissions.

After browser consent, Aevum returns a short-lived waiting page and immediately requests native approval. The page polls only its high-entropy authorization session URL, then redirects to the registered client callback with the one-time code and original state. This avoids holding a tunnel request open while the desktop dialog is pending.

## Security boundaries

- Host and browser Origin values must match either the loopback listener or the configured HTTPS origin.
- The static bearer token works only over the loopback Host, even while OAuth mode is enabled.
- Remote authorization requires both browser consent and a local Aevum desktop confirmation.
- MCP responses expose sanitized task, category, and activity data only. API keys, Telegram credentials, model secrets, settings, update controls, cache controls, and internal debug state are not MCP resources.
- Proposal and Full Access productivity tools never mutate tasks directly; every write creates an in-app proposal. Confirmed MCP changes use the shared transaction/audit/undo engine with source `MCP`.
- The tunnel operator can observe traffic after TLS termination. Treat the Cloudflare account, tunnel credentials, hostname, and local machine as trusted infrastructure.
- Aevum does not provide multi-user identity, account recovery, or a remotely managed authorization dashboard. Disable MCP or stop the tunnel when remote access is not needed.

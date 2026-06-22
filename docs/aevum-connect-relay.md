# Aevum Connect Relay

Aevum Connect gives each desktop installation a stable ChatGPT MCP URL while task data remains on the user's computer. The Railway service stores device authentication and OAuth grant metadata only; it routes encrypted HTTPS/WebSocket traffic and never persists tasks, categories, activity text, prompts, API keys, Telegram tokens, model data, or debug state.

## Railway deployment

1. Create a Railway project and add PostgreSQL.
2. Add a service from this repository. Use `npm ci && npm run build:relay` as the build command and `npm run start:relay` as the start command.
3. Configure the variables below. Railway supplies `PORT` and `DATABASE_URL`.
4. Add a custom domain such as `connect.aevum.app`, enable HTTPS, and set the public origin to that exact origin.
5. Deploy. Database tables are migrated safely when the relay starts.

Required variables:

```text
AEVUM_RELAY_PUBLIC_ORIGIN=https://connect.aevum.app
DATABASE_URL=postgresql://...
AEVUM_RELAY_SIGNING_SECRET=<at least 32 random characters>
AEVUM_RELAY_TOKEN_SECRET=<a different value of at least 32 random characters>
NODE_ENV=production
```

Generate the two secrets independently and keep them in Railway's secret store. Changing either secret invalidates active credentials. The server listens on `process.env.PORT`, accepts Railway's HTTPS proxy, supports WebSocket upgrades, and drains HTTP, WebSocket, database, and pending request state on `SIGTERM`/`SIGINT`.

## Local development

Start PostgreSQL, export the same variables with a local origin, then run:

```powershell
npm run dev:relay
```

For local development only, `AEVUM_RELAY_PUBLIC_ORIGIN=http://localhost:8787` is accepted. Production requires HTTPS. Build and run the compiled service with:

```powershell
npm run build:relay
npm run start:relay
```

The desktop defaults to `https://connect.aevum.app`. A development build can point `mcpRelayOrigin` at the local relay through its stored MCP settings. Device secrets are kept in the OS credential vault and are never shown in Settings or logs.

## OAuth and security model

ChatGPT uses dynamic client registration and authorization code flow with S256 PKCE. Browser consent is paired with one native Aevum approval. Approved grants and hashed rotating refresh tokens persist in PostgreSQL, so tool calls and normal restarts do not repeat approval. Refresh-token reuse revokes its token family. Expanding access mode, revoking a client, resetting the personal URL, or changing relay secrets requires authorization again.

Access tokens are short-lived and signed. Every MCP request is checked against its device and scopes before forwarding. Read-only clients cannot list or call proposal/write tools. Desktop Aevum remains the sole owner and executor of task changes; existing proposal, confirmation, transaction, audit, stale-state, idempotency, and undo behavior remains in force.

Logs contain request IDs, route names, status, duration, access mode, and a short device-ID suffix. Request bodies, MCP payloads, task content, authorization headers, secrets, and tokens are not logged.

## Verification

Production checklist:

- Set `AEVUM_RELAY_PUBLIC_ORIGIN` to the final HTTPS origin.
- Set two independent signing/token secrets.
- Attach Railway PostgreSQL and verify `DATABASE_URL`.
- Enable the custom domain and HTTPS.
- Confirm `GET /healthz` returns `{ "status": "ok" }`.
- Confirm `GET /readyz` returns `{ "status": "ready" }`.
- Inspect `/.well-known/oauth-authorization-server` and the per-device protected-resource metadata.
- Enable Aevum Connect in the desktop app and verify its WebSocket status becomes Connected.
- Copy the stable connector URL into ChatGPT and complete browser plus native approval once.
- Restart both relay and desktop and verify refresh succeeds without another approval.
- Test read-only, proposals, and Full Access tool visibility separately.
- Ask ChatGPT: `Найди задачу в Aevum по слову магазин` and verify `search_tasks` returns an object containing `query`, `tasks`, and `count`.
- Revoke one client, revoke all clients, and reset the personal URL; verify old tokens and the old URL stop working.

Quick Tunnel remains available under the advanced connection mode for temporary testing. Its URL can change after every restart and is not the production Aevum Connect path.
# Production connection defaults

Aevum Connect uses `https://aevumrelay-production.up.railway.app` in packaged builds. The connector URL is computed as `/mcp/<devicePublicId>` and the desktop WebSocket endpoint as `wss://aevumrelay-production.up.railway.app/device/connect`. A development-only `AEVUM_CONNECT_RELAY_ORIGIN` override may be used by an unpackaged desktop build.

OAuth access tokens live for 15 minutes. Rotating refresh-token families live for 60 days; each successful refresh returns a new refresh token and permanently consumes the old one. OAuth clients, grants, hashed refresh tokens, families, revocations, devices, and safe diagnostics are PostgreSQL-backed and survive relay/desktop restarts. The relay never stores tasks, prompts, or application secrets.

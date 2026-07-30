import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  saveIntegration,
  deleteIntegration,
  integrationStatus,
  exchangeCodeForTokens,
  GDOCS_SCOPE,
} from "../integrations";
import type { IntegrationRecord } from "../integrations";
import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import { forgetEntry } from "../capture/lifecycle";
import { makeMirrorStore } from "../integrations/mirror";

// Pending OAuth flows: random state → provider id, 10-minute TTL. The state
// param ties the Google's callback back to the connect attempt that started
// it (CSRF protection for the OAuth flow).
const OAUTH_STATE_PREFIX = "integrations-oauth-state:";
const OAUTH_STATE_TTL_SEC = 600;

export async function handleIntegrationsRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /integrations — provider list + connection status (never the token)
  if (url.pathname === "/integrations" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const integrations = [];
    for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
      integrations.push(integrationStatus(provider, await loadIntegration(env, provider.id)));
    }
    return json({ ok: true, integrations });
  }

  // POST /integrations/:provider/oauth/start — begin a browser OAuth flow.
  // Returns the provider's consent URL; the settings UI navigates to it.
  const oauthStartRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/oauth\/start$/);
  if (oauthStartRoute && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const provider = getProvider(oauthStartRoute[1]);
    if (!provider) return json({ ok: false, error: `Unknown integration: ${oauthStartRoute[1]}` }, 404);
    if (provider.authKind !== "oauth2") {
      return json({ ok: false, error: `${provider.name} does not use OAuth` }, 400);
    }
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return json({
        ok: false,
        error: "Google OAuth is not configured on this deployment — set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.",
      }, 400);
    }

    const state = crypto.randomUUID();
    await env.OAUTH_KV.put(
      `${OAUTH_STATE_PREFIX}${state}`,
      JSON.stringify({ provider: provider.id }),
      { expirationTtl: OAUTH_STATE_TTL_SEC },
    );

    const redirectUri = `${url.origin}/integrations/${provider.id}/oauth/callback`;
    const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    consent.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    consent.searchParams.set("redirect_uri", redirectUri);
    consent.searchParams.set("response_type", "code");
    consent.searchParams.set("scope", GDOCS_SCOPE);
    // offline + consent: guarantees a refresh token on every connect, even
    // for users who previously granted this client access.
    consent.searchParams.set("access_type", "offline");
    consent.searchParams.set("prompt", "consent");
    consent.searchParams.set("state", state);
    return json({ ok: true, url: consent.toString() });
  }

  // GET /integrations/:provider/oauth/callback — Google redirects here after
  // consent. No Bearer auth (it's a top-level browser navigation); the state
  // param issued by oauth/start is the credential. Exchanges the code, stores
  // the connection, and redirects back to the settings UI.
  const oauthCallbackRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/oauth\/callback$/);
  if (oauthCallbackRoute && request.method === "GET") {
    const provider = getProvider(oauthCallbackRoute[1]);
    if (!provider || provider.authKind !== "oauth2") {
      return json({ ok: false, error: "Unknown OAuth integration" }, 404);
    }
    const fail = (message: string) =>
      Response.redirect(`${url.origin}/?integration-error=${encodeURIComponent(message)}`, 302);

    const state = url.searchParams.get("state") ?? "";
    const stored = state ? await env.OAUTH_KV.get(`${OAUTH_STATE_PREFIX}${state}`) : null;
    if (!stored) return fail("OAuth flow expired — please try connecting again.");
    await env.OAUTH_KV.delete(`${OAUTH_STATE_PREFIX}${state}`);
    try {
      if ((JSON.parse(stored) as { provider?: string }).provider !== provider.id) {
        return fail("OAuth flow mismatch — please try connecting again.");
      }
    } catch {
      return fail("OAuth flow expired — please try connecting again.");
    }

    const oauthError = url.searchParams.get("error");
    if (oauthError) return fail(`Google declined the connection (${oauthError}).`);
    const code = url.searchParams.get("code");
    if (!code) return fail("Google did not return an authorization code.");

    try {
      const redirectUri = `${url.origin}/integrations/${provider.id}/oauth/callback`;
      const tokens = await exchangeCodeForTokens(env, code, redirectUri);
      if (!tokens.refresh_token) {
        return fail("Google did not return a refresh token — please try connecting again.");
      }
      // Label the connection with the Google account's name.
      const workspaceName = await provider.validateToken(tokens.access_token).catch(() => "Google account");

      // Preserve the item map across reconnects so already-mirrored docs
      // update in place instead of duplicating (same rule as token connects).
      const existing = await loadIntegration(env, provider.id);
      const now = Date.now();
      const record: IntegrationRecord = {
        provider: provider.id,
        authKind: "oauth2",
        credentials: {
          token: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: now + tokens.expires_in * 1000,
        },
        config: existing?.config ?? {},
        status: "connected",
        workspaceName,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      return Response.redirect(`${url.origin}/?integration-connected=${provider.id}`, 302);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // POST /integrations/:provider/(connect|sync|disconnect)
  const integrationRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/(connect|sync|disconnect)$/);
  if (integrationRoute && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const provider = getProvider(integrationRoute[1]);
    if (!provider) return json({ ok: false, error: `Unknown integration: ${integrationRoute[1]}` }, 404);
    const action = integrationRoute[2];

    // connect — validate the pasted token against the provider's API
    // (server-side; the browser can't for CORS reasons) and store it only if
    // it works.
    if (action === "connect") {
      let body: { token?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const token = body.token?.trim();
      if (!token) return json({ ok: false, error: "token is required" }, 400);

      let workspaceName: string;
      try {
        workspaceName = await provider.validateToken(token);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }

      // Preserve the item map across reconnects so already-mirrored items
      // update in place instead of duplicating.
      const existing = await loadIntegration(env, provider.id);
      const now = Date.now();
      const record: IntegrationRecord = {
        provider: provider.id,
        authKind: "token",
        credentials: { token },
        config: existing?.config ?? {},
        status: "connected",
        workspaceName,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      return json({ ok: true, provider: provider.id, workspaceName });
    }

    // sync — one bounded batch; callers loop while `remaining` > 0 (same
    // pattern as POST /vectorize-pending).
    if (action === "sync") {
      if (!(await loadIntegration(env, provider.id))) {
        return json({ ok: false, error: `${provider.name} is not connected` }, 404);
      }
      const result = await provider.sync(env, makeMirrorStore(env));
      return json(result, result.ok ? 200 : 502);
    }

    // disconnect — remove the connection. Mirrored memories are kept
    // (they're the user's data) unless purge=true.
    let body: { purge?: boolean } = {};
    try { body = await request.json(); } catch { /* empty body — keep memories */ }
    const record = await loadIntegration(env, provider.id);
    if (!record) return json({ ok: false, error: `${provider.name} is not connected` }, 404);

    let purged = 0;
    if (body.purge) {
      for (const mapped of Object.values(record.itemMap)) {
        try {
          const r = await forgetEntry(mapped.entryId, env);
          if (r.status === "deleted") purged++;
        } catch (e) {
          console.error("Mirror purge failed (non-fatal):", e);
        }
      }
    }
    await deleteIntegration(env, provider.id);
    return json({ ok: true, purged, kept: body.purge ? 0 : Object.keys(record.itemMap).length });
  }

  return null;
}

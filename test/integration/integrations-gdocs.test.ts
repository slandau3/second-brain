import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// ─── Google API stub ──────────────────────────────────────────────────────────
// A mutable fixture the stubbed global fetch serves: oauth2.googleapis.com/token
// handles the code exchange + refreshes, /drive/v3/about validates access
// tokens, /drive/v3/files lists docs, and /files/:id/export serves their text.

interface GoogleFixture {
  validAccessToken: string;
  validRefreshToken: string;
  docs: Array<{ id: string; name: string; modifiedTime: string; trashed?: boolean }>;
  text: Record<string, string>;
}

function stubGoogleApi(fixture: GoogleFixture) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;

    if (url === "https://oauth2.googleapis.com/token") {
      const body = String(init?.body ?? "");
      if (body.includes("grant_type=authorization_code") && body.includes("code=google-auth-code")) {
        return new Response(JSON.stringify({
          access_token: fixture.validAccessToken,
          refresh_token: fixture.validRefreshToken,
          expires_in: 3600,
        }), { status: 200 });
      }
      if (body.includes("grant_type=refresh_token") && body.includes(encodeURIComponent(fixture.validRefreshToken))) {
        return new Response(JSON.stringify({ access_token: fixture.validAccessToken, expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }

    const auth = init?.headers?.Authorization ?? "";
    if (auth !== `Bearer ${fixture.validAccessToken}`) {
      return new Response(JSON.stringify({ error: { message: "Request had invalid authentication credentials." } }), { status: 401 });
    }
    if (url.includes("/drive/v3/about")) {
      return new Response(JSON.stringify({ user: { displayName: "Test User", emailAddress: "test@example.com" } }), { status: 200 });
    }
    const exportMatch = url.match(/\/drive\/v3\/files\/([^/?]+)\/export/);
    if (exportMatch) {
      const text = fixture.text[exportMatch[1]];
      if (text == null) return new Response("not found", { status: 404 });
      return new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (url.includes("/drive/v3/files")) {
      const files = fixture.docs.map(d => ({
        id: d.id,
        name: d.name,
        modifiedTime: d.modifiedTime,
        webViewLink: `https://docs.google.com/document/d/${d.id}/edit`,
        trashed: d.trashed === true,
      }));
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
}

describe("google docs integration routes", () => {
  let env: Env;
  let db: D1Mock;
  let fixture: GoogleFixture;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db, {
      OAUTH_KV: makeMemoryKV(),
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    });
    fixture = { validAccessToken: "ya29.valid", validRefreshToken: "1//refresh", docs: [], text: {} };
    stubGoogleApi(fixture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sync = () =>
    worker.fetch(req("POST", "/integrations/gdocs/sync", { body: {} }), env, ctx);

  // Drives the full browser OAuth flow the way the settings UI + Google would:
  // start → follow the consent URL's state → hit the callback with a code.
  async function connectViaOAuth(): Promise<Response> {
    const start = await worker.fetch(req("POST", "/integrations/gdocs/oauth/start", { body: {} }), env, ctx);
    const { url } = await start.json() as any;
    const state = new URL(url).searchParams.get("state")!;
    return worker.fetch(
      new Request(`http://localhost/integrations/gdocs/oauth/callback?code=google-auth-code&state=${state}`),
      env, ctx,
    );
  }

  describe("GET /integrations", () => {
    it("lists gdocs as a disconnected oauth2 provider", async () => {
      const res = await worker.fetch(req("GET", "/integrations"), env, ctx);
      const data = await res.json() as any;
      expect(data.integrations).toContainEqual(
        expect.objectContaining({
          provider: "gdocs",
          connected: false,
          authKind: "oauth2",
          oauthButtonLabel: "Connect with Google",
          category: "knowledge",
        }),
      );
    });
  });

  describe("POST /integrations/gdocs/oauth/start", () => {
    it("requires auth", async () => {
      const res = await worker.fetch(req("POST", "/integrations/gdocs/oauth/start", { token: null }), env, ctx);
      expect(res.status).toBe(401);
    });

    it("returns a Google consent URL with a state that is stored for the callback", async () => {
      const res = await worker.fetch(req("POST", "/integrations/gdocs/oauth/start", { body: {} }), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      const consent = new URL(data.url);
      expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(consent.searchParams.get("client_id")).toBe("test-client-id");
      expect(consent.searchParams.get("redirect_uri")).toBe("http://localhost/integrations/gdocs/oauth/callback");
      expect(consent.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
      expect(consent.searchParams.get("access_type")).toBe("offline");
      expect(consent.searchParams.get("prompt")).toBe("consent");
      const state = consent.searchParams.get("state")!;
      expect(await env.OAUTH_KV.get(`integrations-oauth-state:${state}`)).toBeTruthy();
    });

    it("400s when the deployment has no Google client secrets", async () => {
      const bare = makeTestEnv(db, { OAUTH_KV: makeMemoryKV() });
      const res = await worker.fetch(req("POST", "/integrations/gdocs/oauth/start", { body: {} }), bare, ctx);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain("GOOGLE_CLIENT_ID");
    });

    it("400s for providers that do not use OAuth", async () => {
      const res = await worker.fetch(req("POST", "/integrations/notion/oauth/start", { body: {} }), env, ctx);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /integrations/gdocs/oauth/callback", () => {
    it("rejects an unknown state without storing anything", async () => {
      const res = await worker.fetch(
        new Request("http://localhost/integrations/gdocs/oauth/callback?code=google-auth-code&state=bogus"),
        env, ctx,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("integration-error=");
      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations.find((i: any) => i.provider === "gdocs").connected).toBe(false);
    });

    it("rejects Google-declined consent", async () => {
      const start = await worker.fetch(req("POST", "/integrations/gdocs/oauth/start", { body: {} }), env, ctx);
      const { url } = await start.json() as any;
      const state = new URL(url).searchParams.get("state")!;
      const res = await worker.fetch(
        new Request(`http://localhost/integrations/gdocs/oauth/callback?error=access_denied&state=${state}`),
        env, ctx,
      );
      expect(res.headers.get("location")).toContain("integration-error=");
    });

    it("exchanges the code, stores an oauth2 record, and redirects to the UI", async () => {
      const res = await connectViaOAuth();
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost/?integration-connected=gdocs");

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      const gdocs = status.integrations.find((i: any) => i.provider === "gdocs");
      expect(gdocs).toMatchObject({ connected: true, workspaceName: "Test User" });
      // The stored record carries the refresh token (status never exposes it).
      const stored = JSON.parse((await env.OAUTH_KV.get("integrations:gdocs"))!);
      expect(stored.authKind).toBe("oauth2");
      expect(stored.credentials.refreshToken).toBe("1//refresh");
      expect(stored.credentials.token).toBe("ya29.valid");
      expect(stored.credentials.expiresAt).toBeGreaterThan(Date.now());
      // State is single-use.
      const start2 = await worker.fetch(req("POST", "/integrations/gdocs/oauth/start", { body: {} }), env, ctx);
      const { url: url2 } = await start2.json() as any;
      const state2 = new URL(url2).searchParams.get("state")!;
      await worker.fetch(
        new Request(`http://localhost/integrations/gdocs/oauth/callback?code=google-auth-code&state=${state2}`),
        env, ctx,
      );
      expect(await env.OAUTH_KV.get(`integrations-oauth-state:${state2}`)).toBeNull();
    });

    it("preserves the item map across reconnects", async () => {
      fixture.docs = [{ id: "d1", name: "Plan", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "body one";
      await connectViaOAuth();
      await sync();
      const entryId = db.entries[0].id;

      // Reconnect: the OAuth flow runs again, the mirror must survive in place.
      await connectViaOAuth();
      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ created: 0, updated: 0 });
      expect(db.entries).toHaveLength(1);
      expect(db.entries[0].id).toBe(entryId);
    });
  });

  describe("POST /integrations/gdocs/sync", () => {
    it("404s when not connected", async () => {
      const res = await sync();
      expect(res.status).toBe(404);
    });

    it("mirrors docs into entries with source gdocs", async () => {
      fixture.docs = [{ id: "d1", name: "Project Plan", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "Ship the beta in March";
      await connectViaOAuth();

      const res = await sync();
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toMatchObject({ ok: true, created: 1, updated: 0, deleted: 0, remaining: 0, total: 1 });

      expect(db.entries).toHaveLength(1);
      const entry = db.entries[0];
      expect(entry.source).toBe("gdocs");
      expect(JSON.parse(entry.tags)).toEqual(["gdocs"]);
      expect(entry.content).toContain("# Project Plan");
      expect(entry.content).toContain("https://docs.google.com/document/d/d1/edit");
      expect(entry.content).toContain("Ship the beta in March");
    });

    it("replaces a mirrored entry in place when the doc is edited", async () => {
      fixture.docs = [{ id: "d1", name: "Note A", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "test";
      await connectViaOAuth();
      await sync();
      const originalId = db.entries[0].id;

      fixture.docs = [{ id: "d1", name: "Note A", modifiedTime: "2026-01-08T00:00:00.000Z" }];
      fixture.text["d1"] = "test2";

      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ created: 0, updated: 1 });
      expect(db.entries).toHaveLength(1);
      expect(db.entries[0].id).toBe(originalId);
      expect(db.entries[0].content).toContain("test2");
    });

    it("deletes the mirror when a doc is trashed", async () => {
      fixture.docs = [{ id: "d1", name: "Note", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "test";
      await connectViaOAuth();
      await sync();

      fixture.docs = [{ id: "d1", name: "Note", modifiedTime: "2026-01-02T00:00:00.000Z", trashed: true }];
      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ deleted: 1, created: 0 });
      expect(db.entries).toHaveLength(0);
    });

    it("processes large backlogs in bounded batches and reports remaining", async () => {
      fixture.docs = Array.from({ length: 7 }, (_, i) => ({
        id: `d${i}`, name: `Doc ${i}`, modifiedTime: `2026-01-0${i + 1}T00:00:00.000Z`,
      }));
      for (let i = 0; i < 7; i++) fixture.text[`d${i}`] = `body ${i}`;
      await connectViaOAuth();

      const first = await (await sync()).json() as any;
      expect(first).toMatchObject({ created: 5, remaining: 2 });
      const second = await (await sync()).json() as any;
      expect(second).toMatchObject({ created: 2, remaining: 0 });
      expect(db.entries).toHaveLength(7);
    });

    it("refreshes an expired access token mid-sync", async () => {
      fixture.docs = [{ id: "d1", name: "Note", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "test";
      await connectViaOAuth();

      // Force the stored access token to be expired: sync must transparently
      // refresh it (the stub accepts the refresh token) and still work.
      const stored = JSON.parse((await env.OAUTH_KV.get("integrations:gdocs"))!);
      stored.credentials.token = "ya29.stale";
      stored.credentials.expiresAt = Date.now() - 1000;
      await env.OAUTH_KV.put("integrations:gdocs", JSON.stringify(stored));

      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ ok: true, created: 1 });
      const after = JSON.parse((await env.OAUTH_KV.get("integrations:gdocs"))!);
      expect(after.credentials.token).toBe("ya29.valid");
    });

    it("records the error and returns 502 when the token is revoked", async () => {
      fixture.docs = [{ id: "d1", name: "Note", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "test";
      await connectViaOAuth();

      // Revoke: the refresh token stops working (stub returns invalid_grant).
      const stored = JSON.parse((await env.OAUTH_KV.get("integrations:gdocs"))!);
      stored.credentials.expiresAt = Date.now() - 1000;
      await env.OAUTH_KV.put("integrations:gdocs", JSON.stringify(stored));
      fixture.validRefreshToken = "1//rotated-away";

      const res = await sync();
      expect(res.status).toBe(502);
      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      const gdocs = status.integrations.find((i: any) => i.provider === "gdocs");
      expect(gdocs.status).toBe("error");
      expect(gdocs.lastSyncError).toContain("reconnect Google Docs");
    });
  });

  describe("POST /integrations/gdocs/disconnect", () => {
    it("removes the connection and purges mirrors when asked", async () => {
      fixture.docs = [{ id: "d1", name: "Note", modifiedTime: "2026-01-01T00:00:00.000Z" }];
      fixture.text["d1"] = "test";
      await connectViaOAuth();
      await sync();

      const res = await worker.fetch(
        req("POST", "/integrations/gdocs/disconnect", { body: { purge: true } }), env, ctx,
      );
      const data = await res.json() as any;
      expect(data).toMatchObject({ ok: true, purged: 1, kept: 0 });
      expect(db.entries).toHaveLength(0);
      expect(await env.OAUTH_KV.get("integrations:gdocs")).toBeNull();
    });
  });
});

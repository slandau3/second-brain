import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildDocContent,
  computeGdocsPlan,
  ensureAccessToken,
  gdocsProvider,
  getProvider,
  integrationStatus,
  loadIntegration,
} from "../../src/integrations";
import type { GdocsDocMeta, IntegrationRecord, ItemMapEntry } from "../../src/integrations";
import { makeMemoryKV } from "../helpers/make-env";

function doc(id: string, modifiedTime: string, trashed = false): GdocsDocMeta {
  return {
    id,
    modifiedTime,
    title: `Doc ${id}`,
    url: `https://docs.google.com/document/d/${id}/edit`,
    trashed,
  };
}

const map = (entries: Record<string, string>): Record<string, ItemMapEntry> =>
  Object.fromEntries(Object.entries(entries).map(([id, version]) => [id, { entryId: `e-${id}`, version }]));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildDocContent", () => {
  it("leads with title and source URL", () => {
    const content = buildDocContent("My Doc", "https://docs.google.com/document/d/abc/edit", "body text");
    expect(content).toBe("# My Doc\nhttps://docs.google.com/document/d/abc/edit\n\nbody text");
  });

  it("truncates very long bodies", () => {
    const content = buildDocContent("T", "u", "x".repeat(10000));
    expect(content.length).toBeLessThan(9000);
    expect(content.endsWith("…")).toBe(true);
  });
});

describe("computeGdocsPlan", () => {
  it("treats unseen docs as changed", () => {
    const plan = computeGdocsPlan([doc("a", "2026-01-01T00:00:00Z")], {}, true);
    expect(plan.changed.map(d => d.id)).toEqual(["a"]);
    expect(plan.deleted).toEqual([]);
  });

  it("treats edited docs as changed and unchanged docs as no-ops", () => {
    const itemMap = map({ a: "2026-01-01T00:00:00Z", b: "2026-01-01T00:00:00Z" });
    const plan = computeGdocsPlan(
      [doc("a", "2026-01-02T00:00:00Z"), doc("b", "2026-01-01T00:00:00Z")],
      itemMap,
      true,
    );
    expect(plan.changed.map(d => d.id)).toEqual(["a"]);
  });

  it("orders changed docs oldest first so partial batches converge", () => {
    const plan = computeGdocsPlan(
      [doc("new", "2026-03-01T00:00:00Z"), doc("old", "2026-01-01T00:00:00Z")],
      {},
      true,
    );
    expect(plan.changed.map(d => d.id)).toEqual(["old", "new"]);
  });

  it("deletes mirrors for docs missing from a COMPLETE listing", () => {
    const plan = computeGdocsPlan([], map({ gone: "2026-01-01T00:00:00Z" }), true);
    expect(plan.deleted).toEqual(["gone"]);
  });

  it("never deletes from a truncated listing", () => {
    const plan = computeGdocsPlan([], map({ gone: "2026-01-01T00:00:00Z" }), false);
    expect(plan.deleted).toEqual([]);
  });

  it("deletes trashed docs even from a truncated listing", () => {
    const plan = computeGdocsPlan(
      [doc("a", "2026-01-02T00:00:00Z", true)],
      map({ a: "2026-01-01T00:00:00Z" }),
      false,
    );
    expect(plan.deleted).toEqual(["a"]);
    expect(plan.changed).toEqual([]); // trashed docs are never re-ingested
  });
});

function oauthRecord(overrides: Partial<IntegrationRecord["credentials"]> = {}): IntegrationRecord {
  return {
    provider: "gdocs",
    authKind: "oauth2",
    credentials: {
      token: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt: Date.now() + 3600_000,
      ...overrides,
    },
    config: {},
    status: "connected",
    workspaceName: "Test User",
    lastSyncedAt: null,
    lastSyncError: null,
    itemMap: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

const googleEnv = (kv: KVNamespace) => ({
  OAUTH_KV: kv,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
});

describe("ensureAccessToken", () => {
  it("returns the stored token when it is not near expiry", async () => {
    const kv = makeMemoryKV();
    const record = oauthRecord();
    const token = await ensureAccessToken(googleEnv(kv), record);
    expect(token).toBe("ya29.access");
  });

  it("returns token-auth credentials untouched", async () => {
    const kv = makeMemoryKV();
    const record = oauthRecord();
    record.authKind = "token";
    record.credentials = { token: "manual-token" };
    const token = await ensureAccessToken(googleEnv(kv), record);
    expect(token).toBe("manual-token");
  });

  it("refreshes an expired token and persists the new one", async () => {
    const kv = makeMemoryKV();
    const record = oauthRecord({ token: "ya29.old", expiresAt: Date.now() - 1000 });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "ya29.new",
      expires_in: 3600,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await ensureAccessToken(googleEnv(kv), record);
    expect(token).toBe("ya29.new");
    // Refresh request went to Google's token endpoint with the refresh token.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=1%2F%2Frefresh");
    // The record (and its KV blob) now carries the new token + expiry.
    expect(record.credentials.token).toBe("ya29.new");
    expect(record.credentials.expiresAt).toBeGreaterThan(Date.now());
    const stored = await loadIntegration({ OAUTH_KV: kv }, "gdocs");
    expect(stored?.credentials.token).toBe("ya29.new");
  });

  it("keeps a rotated refresh token when Google returns one", async () => {
    const kv = makeMemoryKV();
    const record = oauthRecord({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "ya29.new",
      expires_in: 3600,
      refresh_token: "1//rotated",
    }), { status: 200 })));

    await ensureAccessToken(googleEnv(kv), record);
    expect(record.credentials.refreshToken).toBe("1//rotated");
  });

  it("throws a reconnect message when the refresh is rejected", async () => {
    const kv = makeMemoryKV();
    const record = oauthRecord({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_grant",
    }), { status: 400 })));

    await expect(ensureAccessToken(googleEnv(kv), record)).rejects.toThrow(/reconnect Google Docs/);
  });

  it("throws when the deployment is missing Google client secrets", async () => {
    const kv = makeMemoryKV();
    const record = oauthRecord({ expiresAt: Date.now() - 1000 });
    await expect(ensureAccessToken({ OAUTH_KV: kv }, record)).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe("gdocs provider registration + status", () => {
  it("is registered under gdocs and marked as an oauth2 provider", () => {
    expect(getProvider("gdocs")).toBe(gdocsProvider);
    expect(gdocsProvider.authKind).toBe("oauth2");
    expect(gdocsProvider.category).toBe("knowledge");
  });

  it("status advertises the OAuth connect button and never exposes tokens", () => {
    const status = integrationStatus(gdocsProvider, oauthRecord());
    expect(status).toMatchObject({
      provider: "gdocs",
      connected: true,
      authKind: "oauth2",
      oauthButtonLabel: "Connect with Google",
      workspaceName: "Test User",
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("ya29.access");
    expect(serialized).not.toContain("1//refresh");
  });

  it("status for a disconnected provider invites the OAuth flow", () => {
    const status = integrationStatus(gdocsProvider, null);
    expect(status).toMatchObject({
      provider: "gdocs",
      connected: false,
      authKind: "oauth2",
      category: "knowledge",
    });
  });
});

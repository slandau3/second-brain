/**
 * Second Brain — Google Docs provider (read-only).
 *
 * Mirrors every Google Doc the user can access into memory. Connection is a
 * Google OAuth2 authorization-code flow (see routes/integrations.ts
 * oauth/start + oauth/callback) with the single read-only scope
 * `drive.readonly` — enough to list Docs via Drive files.list and to read
 * their content via files.export as text/plain. No write scopes are
 * requested; this integration can never modify a document.
 *
 * Sync semantics follow the Notion provider: per-doc version comparison
 * (Drive's modifiedTime) against the itemMap, trashed docs are an explicit
 * delete signal, and silent disappearance (doc deleted permanently or access
 * revoked) only deletes mirrors when the listing completed within the request
 * budget.
 */

import type { IntegrationEnv, IntegrationProvider, IntegrationRecord, ItemMapEntry, MirrorStore, SyncOutcome } from "./framework";
import { loadIntegration, saveIntegration } from "./framework";

// ─── API client ───────────────────────────────────────────────────────────────

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GDOCS_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Same Workers free-plan budget reasoning as the Notion provider: a full sync
// batch costs ≤ MAX_LISTING_REQUESTS + SYNC_DOC_BATCH ≈ 10 external fetches.
const LIST_PAGE_SIZE = 100;
const MAX_LISTING_REQUESTS = 5;   // ≤ 500 accessible docs listed per sync
export const SYNC_DOC_BATCH = 5;  // docs ingested per sync call; callers loop on `remaining`
const MAX_DOC_CONTENT_CHARS = 8000;
// Refresh access tokens this far ahead of expiry so a slow sync never runs on
// a token that dies mid-batch.
const TOKEN_REFRESH_SKEW_MS = 60_000;

async function driveFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${DRIVE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let message = `Google Drive API error (${res.status})`;
    try {
      const body = await res.json() as any;
      if (body?.error?.message) message = `Google Drive: ${body.error.message}`;
    } catch { /* non-JSON error body — keep the status message */ }
    throw new Error(message);
  }
  return res.json();
}

// ─── OAuth2 token lifecycle ───────────────────────────────────────────────────

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;      // seconds
  refresh_token?: string;  // only on the initial code exchange (prompt=consent)
}

export async function exchangeCodeForTokens(
  env: IntegrationEnv,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured on this deployment — set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.");
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    let message = `Google token exchange failed (${res.status})`;
    try {
      const body = await res.json() as any;
      if (body?.error_description) message = `Google: ${body.error_description}`;
    } catch { /* keep status message */ }
    throw new Error(message);
  }
  return res.json() as Promise<GoogleTokenResponse>;
}

// Returns an access token that will stay valid for at least
// TOKEN_REFRESH_SKEW_MS, refreshing via the stored refresh token when needed.
// Mutates + persists the record when a refresh happens so the new token is
// reused by the next sync.
export async function ensureAccessToken(env: IntegrationEnv, record: IntegrationRecord): Promise<string> {
  if (record.authKind !== "oauth2") return record.credentials.token;
  const { token, refreshToken, expiresAt } = record.credentials;
  if (expiresAt && Date.now() + TOKEN_REFRESH_SKEW_MS < expiresAt) return token;
  if (!refreshToken) {
    throw new Error("Google connection is missing its refresh token — please reconnect Google Docs.");
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured on this deployment — set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.");
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // invalid_grant means the user revoked access (or the refresh token
    // expired) — only a fresh consent flow can fix it.
    throw new Error("Google access was revoked or expired — please reconnect Google Docs.");
  }
  const data = await res.json() as GoogleTokenResponse;
  record.credentials.token = data.access_token;
  record.credentials.expiresAt = Date.now() + data.expires_in * 1000;
  // Google may rotate the refresh token; keep the new one when provided.
  if (data.refresh_token) record.credentials.refreshToken = data.refresh_token;
  record.updatedAt = Date.now();
  await saveIntegration(env, record);
  return data.access_token;
}

// The account label for the settings UI's "Connected to …" confirmation.
export async function gdocsValidateToken(token: string): Promise<string> {
  const about = await driveFetch(token, "/about?fields=user");
  const user = about?.user;
  return user?.displayName ?? user?.emailAddress ?? "Google account";
}

// ─── Listing + content ────────────────────────────────────────────────────────

export interface GdocsDocMeta {
  id: string;
  modifiedTime: string;
  title: string;
  url: string;
  trashed: boolean;
}

// List every Google Doc the connection can access, including trashed ones
// (they're the explicit delete signal, like Notion's archived flag).
export async function gdocsListDocs(token: string): Promise<{ docs: GdocsDocMeta[]; complete: boolean }> {
  const docs: GdocsDocMeta[] = [];
  let pageToken: string | undefined;
  let complete = false;
  for (let i = 0; i < MAX_LISTING_REQUESTS; i++) {
    const qs = new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.document'",
      fields: "nextPageToken, files(id, name, modifiedTime, webViewLink, trashed)",
      pageSize: String(LIST_PAGE_SIZE),
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await driveFetch(token, `/files?${qs}`);
    for (const f of (data.files ?? []) as any[]) {
      docs.push({
        id: f.id as string,
        modifiedTime: (f.modifiedTime as string) ?? "",
        title: (f.name as string) ?? "Untitled",
        url: (f.webViewLink as string) ?? `https://docs.google.com/document/d/${f.id}/edit`,
        trashed: f.trashed === true,
      });
    }
    if (!data.nextPageToken) { complete = true; break; }
    pageToken = data.nextPageToken as string;
  }
  return { docs, complete };
}

// A doc's content as plain text. files.export is one request per doc and
// handles all of Drive's internal structure — no block walking like Notion.
export async function gdocsFetchDocText(token: string, docId: string): Promise<string> {
  const qs = new URLSearchParams({ mimeType: "text/plain" });
  const res = await fetch(`${DRIVE_API_BASE}/files/${docId}/export?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google Drive export error (${res.status}) for doc ${docId}`);
  }
  return res.text();
}

// Title + source URL lead the content, same as the Notion provider: the title
// sharpens embedding quality and the URL lets recall link back to the live doc.
export function buildDocContent(title: string, url: string, text: string): string {
  const body = text.length > MAX_DOC_CONTENT_CHARS ? `${text.slice(0, MAX_DOC_CONTENT_CHARS)}\n…` : text;
  return [`# ${title}`, url, "", body].join("\n").trim();
}

// ─── Sync planning ────────────────────────────────────────────────────────────
// Identical semantics to the Notion provider's computeSyncPlan: per-item
// version comparison against the itemMap, oldest-first so partial batches
// converge, and a completeness-gated deletion sweep.

export interface GdocsSyncPlan {
  changed: GdocsDocMeta[]; // new or edited, oldest first so partial batches converge
  deleted: string[];       // doc ids whose mirrors should be removed
}

export function computeGdocsPlan(
  docs: GdocsDocMeta[],
  itemMap: Record<string, ItemMapEntry>,
  listingComplete: boolean,
): GdocsSyncPlan {
  const changed = docs
    .filter(d => !d.trashed && itemMap[d.id]?.version !== d.modifiedTime)
    .sort((a, b) => (a.modifiedTime < b.modifiedTime ? -1 : 1));

  const deleted: string[] = [];
  // Trashed docs are an explicit delete signal even on a truncated listing.
  for (const d of docs) {
    if (d.trashed && itemMap[d.id]) deleted.push(d.id);
  }
  // Silent disappearance (doc permanently deleted or access revoked) is only
  // trustworthy when the listing was complete — a truncated listing must never
  // trigger deletions.
  if (listingComplete) {
    const listed = new Set(docs.map(d => d.id));
    for (const id of Object.keys(itemMap)) {
      if (!listed.has(id)) deleted.push(id);
    }
  }
  return { changed, deleted };
}

// ─── Sync loop ────────────────────────────────────────────────────────────────

async function runGdocsSync(env: IntegrationEnv, store: MirrorStore): Promise<SyncOutcome> {
  const record = await loadIntegration(env, gdocsProvider.id);
  if (!record) return { ok: false, error: "Google Docs is not connected" };

  let accessToken: string;
  let docs: GdocsDocMeta[];
  let complete: boolean;
  try {
    accessToken = await ensureAccessToken(env, record);
    ({ docs, complete } = await gdocsListDocs(accessToken));
  } catch (e) {
    record.status = "error";
    record.lastSyncError = e instanceof Error ? e.message : String(e);
    record.updatedAt = Date.now();
    await saveIntegration(env, record);
    return { ok: false, error: record.lastSyncError };
  }

  const plan = computeGdocsPlan(docs, record.itemMap, complete);
  const batch = plan.changed.slice(0, SYNC_DOC_BATCH);

  let created = 0, updated = 0, failed = 0;
  for (const doc of batch) {
    try {
      const text = await gdocsFetchDocText(accessToken, doc.id);
      const content = buildDocContent(doc.title, doc.url, text);
      const existing = record.itemMap[doc.id];
      if (existing && await store.updateEntry(existing.entryId, content)) {
        record.itemMap[doc.id] = { entryId: existing.entryId, version: doc.modifiedTime };
        updated++;
      } else {
        // New doc — or its mirror was deleted out-of-band; (re-)create it.
        const entryId = await store.createEntry(content, [gdocsProvider.id], gdocsProvider.id);
        record.itemMap[doc.id] = { entryId, version: doc.modifiedTime };
        created++;
      }
    } catch (e) {
      // Per-doc failure is non-fatal: the itemMap doesn't advance for this
      // doc, so the next sync retries it.
      console.error(`Google Docs sync failed for doc ${doc.id} (non-fatal):`, e);
      failed++;
    }
  }

  let deleted = 0;
  for (const docId of plan.deleted) {
    const mapped = record.itemMap[docId];
    if (!mapped) continue;
    try {
      await store.deleteEntry(mapped.entryId);
      delete record.itemMap[docId];
      deleted++;
    } catch (e) {
      console.error(`Google Docs mirror delete failed for doc ${docId} (non-fatal):`, e);
    }
  }

  record.status = "connected";
  record.lastSyncedAt = Date.now();
  record.lastSyncError = null;
  record.updatedAt = Date.now();
  await saveIntegration(env, record);

  return {
    ok: true,
    created,
    updated,
    deleted,
    failed,
    remaining: plan.changed.length - batch.length,
    total: docs.filter(d => !d.trashed).length,
  };
}

export const gdocsProvider: IntegrationProvider = {
  id: "gdocs",
  name: "Google Docs",
  category: "knowledge",
  authKind: "oauth2",
  oauthButtonLabel: "Connect with Google",
  connectHint:
    "Sign in with Google to mirror your Docs (read-only — Second Brain can never edit them). Syncs titles and full text, and removes memories when you trash a doc.",
  // Accepts a raw access token as an escape hatch (e.g. from the OAuth
  // playground for local smoke tests). Normal connects go through the OAuth
  // redirect flow, which never touches validateToken.
  validateToken: gdocsValidateToken,
  sync: runGdocsSync,
};

// Bindings come from the generated Cloudflare.Env (see `wrangler types`);
// VECTORIZE_GRACE_MS is widened from its generated literal default so tests
// and per-deploy vars can override it. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// are optional secrets (`wrangler secret put …`) that enable the Google Docs
// integration's OAuth flow; without them every other integration keeps working.
export interface Env extends Omit<Cloudflare.Env, "VECTORIZE_GRACE_MS" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET"> {
  VECTORIZE_GRACE_MS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

// Worker version, echoed by GET /health. The desktop app compares this against
// the version it bundles to offer a one-click "update your Second Brain".
// Bump (semver) when the Worker changes; see installer/README "Worker versioning".
export const SB_VERSION = "2.2.0";

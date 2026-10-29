/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { runNightlyCompression } from "./compression/nightly";
import { runGraphPass } from "./graph/pass";
import { runScheduledIntegrationSync } from "./integrations/mirror";
import { apiHandler } from "./mcp/handler";
import { augmentOAuthRegistrationRequest } from "./oauth/register";
import { defaultHandler } from "./routes";

export type { Env } from "./env";

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Library defaults expire refresh tokens 30 days after authorization (not extended on
  // refresh) and DCR clients after 90 days, which silently disconnects ChatGPT/Claude.ai
  // connectors. Single-owner server: keep grants until revoked.
  refreshTokenTTL: undefined,
  clientRegistrationTTL: undefined,
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken: async ({ token, env }) => {
    if (token === (env as Env).AUTH_TOKEN) {
      return { props: { userId: "owner" } };
    }
    return null;
  },
});

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const augmented = await augmentOAuthRegistrationRequest(req);
      return oauthProvider.fetch(augmented, env as any, ctx);
    }
    return oauthProvider.fetch(req, env as any, ctx);
  },
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runNightlyCompression(env, ctx));
    ctx.waitUntil(runGraphPass(env, ctx));
    ctx.waitUntil(runScheduledIntegrationSync(env));
  },
};

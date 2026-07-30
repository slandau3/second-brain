/**
 * Live smoke test for the Google Docs provider — hits the REAL Google Drive
 * API with a real access token. Skipped unless GOOGLE_ACCESS_TOKEN is set:
 *
 *   1. Get a token at https://developers.google.com/oauthplayground/
 *      (gear icon → "Use your own OAuth credentials" optional; select scope
 *      Drive API v3 → https://www.googleapis.com/auth/drive.readonly →
 *      Authorize → Exchange for tokens).
 *   2. Run:
 *      GOOGLE_ACCESS_TOKEN=ya29.... npx vitest run test/live
 *
 * Verifies the provider's API assumptions (listing fields, export format,
 * account label) against the real API — the things mocks can't catch.
 */
import { describe, it, expect } from "vitest";
import { gdocsListDocs, gdocsFetchDocText, gdocsValidateToken, buildDocContent } from "../../src/integrations";

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;

describe.skipIf(!TOKEN)("google docs live smoke", () => {
  it("validates the token and returns the account label", async () => {
    const label = await gdocsValidateToken(TOKEN!);
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    console.log(`  connected as: ${label}`);
  });

  it("lists docs with the fields the sync plan relies on", async () => {
    const { docs, complete } = await gdocsListDocs(TOKEN!);
    expect(complete).toBe(true);
    console.log(`  docs visible: ${docs.length}`);
    for (const d of docs.slice(0, 5)) {
      expect(d.id).toBeTruthy();
      expect(d.title).toBeTruthy();
      expect(d.modifiedTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(d.url).toContain(d.id);
      console.log(`  - ${d.title} (${d.modifiedTime})`);
    }
  });

  it("exports a doc's text and builds mirror content", async () => {
    const { docs } = await gdocsListDocs(TOKEN!);
    const target = docs.find(d => !d.trashed);
    if (!target) {
      console.log("  no non-trashed docs visible — skipping export check");
      return;
    }
    const text = await gdocsFetchDocText(TOKEN!, target.id);
    expect(typeof text).toBe("string");
    const content = buildDocContent(target.title, target.url, text);
    expect(content.startsWith(`# ${target.title}`)).toBe(true);
    console.log(`  exported "${target.title}": ${text.length} chars`);
  });
});

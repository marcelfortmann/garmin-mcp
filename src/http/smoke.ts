/**
 * Milestone test for layer 1.
 *
 * Fetches the public Garmin SSO embed page and checks whether our TLS-impersonated
 * client gets through Cloudflare. Expectation: status 200 and NO Cloudflare
 * challenge in the HTML. No login, no credentials.
 *
 *   npm run smoke
 */
import { ImpersonatedHttp } from "./impersonate.js";

const SSO_EMBED = "https://sso.garmin.com/sso/embed";
const EMBED_PARAMS = {
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: "https://sso.garmin.com/sso",
};

// Markers of a REAL Cloudflare block page ("Just a moment ...").
// Important: do NOT check for "challenge-platform" — that script is referenced by
// Cloudflare even on perfectly normal 200 pages. A real block is a small
// interstitial page (title "Just a moment", usually status 403/503) with cf_chl markers.
const HARD_BLOCK_MARKERS = [
  "just a moment",
  "attention required",
  "cf_chl_opt",
  "window._cf_chl",
  "cf-error-details",
];

async function main(): Promise<void> {
  const http = new ImpersonatedHttp();
  try {
    console.log(`GET ${SSO_EMBED} ...`);
    const res = await http.get(SSO_EMBED, { params: EMBED_PARAMS });

    const lower = res.text.toLowerCase();
    const titleMatch = res.text.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "(no title)";
    const marker = HARD_BLOCK_MARKERS.find((m) => lower.includes(m));
    // Blocked if a hard marker appears OR Cloudflare rejects with 403/503/429.
    const blocked = Boolean(marker) || [403, 429, 503].includes(res.status);

    console.log(`Status:      ${res.status}`);
    console.log(`Title:       ${title}`);
    console.log(`Body length: ${res.text.length} chars`);
    console.log(`Challenge:   ${blocked ? `YES${marker ? ` (marker "${marker}")` : ""}` : "no"}`);

    if (res.status === 200 && !blocked) {
      console.log("\n✅ Smoke test passed — the client gets through Cloudflare.");
    } else {
      console.log(
        "\n❌ Smoke test FAILED. Consider updating the JA3/User-Agent in " +
          "src/http/impersonate.ts to a current Chrome.",
      );
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("\n❌ Smoke test failed with error:", err);
    process.exitCode = 1;
  } finally {
    await http.close();
  }
}

void main();

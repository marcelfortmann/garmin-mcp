# Garmin → Claude MCP server

> Analyze your own Garmin Connect data — activities, sleep, HRV, Body Battery,
> training readiness — right inside Claude Desktop.

A **fully local**, **read-only** MCP server that lets you analyze your **own**
Garmin Connect data in **Claude Desktop**. The server runs as a local child process
of Claude Desktop and talks to it over **stdio**.

## Guiding principles

- **100% local** — nothing is hosted or exposed to the network (stdio).
- **Read-only** — there is no write endpoint to Garmin.
- **No third party** — the only network contact is Garmin. No telemetry, no external logging.
- **Passwordless at runtime** — the password is **never** stored; after the one-time login only local tokens are used.

## Requirements

- **Node.js ≥ 20** (tested with Node 22 LTS), npm.
- A Garmin Connect account.

## Setup (4 steps)

```bash
# 1) Install dependencies
npm install

# 2) Milestone test: does the client get through Garmin's Cloudflare protection?
npm run smoke
#    Expectation: "Status 200" and "Challenge: no".

# 3) One-time interactive login (prompts for email, hidden password, MFA if enabled)
npm run login
#    Creates ~/.garmin-mcp/tokens.json (mode 0600). The password is NOT stored.

# 4) Compile TypeScript to build/
npm run build
```

## Connecting Claude Desktop

Claude Desktop → **Settings → Developer → Edit Config**. Add the server with its
**absolute path** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-mcp/build/mcp/server.js"]
    }
  }
}
```

Then **restart** Claude Desktop. Try it in chat, e.g.:

> "Am I logged in to Garmin? Use `whoami`."
> "Show me my daily summary and my recent activities."

## Available tools

**13 read-only tools.** Date parameters are `YYYY-MM-DD` (default = today); ranges
default to the last ~4 weeks. Several tools take a `metrics[]` / `include[]` selector,
so one tool covers many data types (this keeps the tool list small for good tool
selection). Long time series in responses are truncated to stay compact.

| Tool | Description |
|---|---|
| `whoami` | Connection check + account profile |
| `get_daily_health` | Daily wellness for a date — `metrics[]`: summary, sleep, stress, heart_rate, hrv, spo2, respiration, hydration, steps, floors, intensity_minutes, body_battery, body_battery_events, stats_and_body |
| `get_training` | Training for a date — `metrics[]`: readiness, morning_readiness, status, vo2max, fitness_age |
| `get_fitness` | Fitness/performance — `metrics[]`: race_predictions, cycling_ftp, lactate_threshold, personal_records, endurance_score, hill_score, resting_heart_rate, weekly_intensity_minutes (`startDate`/`endDate`) |
| `get_weight` | Body weight & composition over a range (`include_raw` also returns weigh-ins) |
| `get_steps_history` | Step totals over a range — `granularity`: daily or weekly |
| `get_activity` | One activity by `activityId` — `include[]`: summary, splits, weather, details, hr_zones, exercise_sets |
| `list_activities` | Recent activities, or by date range/type (`limit`/`startDate`/`endDate`/`type`) |
| `get_devices` | Paired Garmin devices |
| `get_user_profile` | User profile & settings (units, preferences) |
| `get_goals` | Goals (`status`: active/future/past, `limit`) |
| `get_workouts` | Saved workouts (`limit`) |
| `get_scheduled_workouts` | Scheduled workouts / calendar (`year`/`month`) |

## How it works

The server registers each Garmin data method as an MCP tool and talks to Claude
Desktop over stdio. Every call goes through a generic `connectapi()` request to
`connectapi.garmin.com` with a bearer token, sent via
[`cycletls`](https://github.com/Danny-Dasilva/CycleTLS) so the TLS fingerprint looks
like a real browser (Garmin sits behind Cloudflare).

Authentication happens once (`npm run login`): a login cascade — mobile iOS JSON
login first, the classic widget/CSRF flow as fallback — yields a CAS service ticket,
which is exchanged in Garmin's DI-OAuth2 flow for an access + refresh token. The
tokens are cached locally and the access token is refreshed automatically on expiry;
your password is never stored.

## Security model

- The **password is never** stored — it is only used for the one-time login.
- Tokens live at `~/.garmin-mcp/tokens.json` with file mode **`0600`** (only you can read them).
- The access token is renewed automatically via the refresh token when it expires.
- **Read-only**: there is no code path that changes anything on Garmin.
- No telemetry, no external logging. Diagnostics go to `stderr` only (never over the stdio MCP channel).

## Architecture (layers)

- `src/http/impersonate.ts` — TLS impersonation via [`cycletls`](https://github.com/Danny-Dasilva/CycleTLS) (JA3 fingerprint) + cookie jar, so Garmin's bot protection lets us through.
- `src/http/smoke.ts` — milestone test against `sso/embed`.
- `src/garmin/auth.ts` — login cascade (mobile iOS JSON login → widget/CSRF fallback) + MFA + DI-OAuth2 ticket exchange + refresh.
- `src/garmin/tokens.ts` — local token cache (0600).
- `src/garmin/client.ts` — generic `connectapi()` + typed, read-only data methods.
- `src/mcp/server.ts` — MCP server, tool registration, stdio transport.
- `src/cli/login.ts` — one-time interactive login.

## Development

```bash
npm run build     # tsc -> build/
npm test          # unit tests for the pure helpers (no network, no credentials)
npm run smoke     # milestone test against Garmin's Cloudflare (needs network)
npm run login     # one-time interactive login (needs your credentials)
npm start         # run the built server directly (normally Claude Desktop does this)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build` and `npm test` on
Node 22. `build` doubles as the type-check. `smoke` and `login` are deliberately
excluded — they need live Garmin access and real credentials, and would be flaky.

`npm test` covers the pure helpers only (`trimLongArrays`, `decodeJwtExp`,
`toSearchParams`) and never imports the MCP SDK, so a green test run says nothing
about tool registration. After changing tools or upgrading dependencies, probe the
server over stdio. **No Garmin credentials are needed** — registration and argument
validation both happen before any authentication:

```bash
npm run build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node build/mcp/server.js
```

Expect an `initialize` reply plus a `tools/list` reply containing all 13 tools with
their input schemas. To also confirm that argument validation still bites, add one
more line to the `printf` above — it should come back as `-32602`, not as a login
error:

```text
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_activity","arguments":{"activityId":"not-a-number"}}}' \
```

Dependencies are updated by Dependabot (`.github/dependabot.yml`, weekly). The npm
updates arrive as **one grouped PR that can include major versions**, so read its
`package.json` diff before merging, and run the stdio probe above rather than
trusting a green build alone.

## Maintenance & risks (named honestly)

This uses Garmin's **unofficial** internal API, ported from the open-source Python
package [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect).
Expected breakage points and how to fix them:

- **Unofficial API** — endpoint paths can change. On errors, compare the paths in `src/garmin/client.ts` against the current `python-garminconnect` source.
- **JA3 / User-Agent** — on a `403` or a "Just a moment …" Cloudflare page, update the JA3/User-Agent pair in `src/http/impersonate.ts` to a current Chrome (both together).
- **Client ids** — the DI-OAuth2 client ids (`GARMIN_CONNECT_MOBILE_ANDROID_DI_*`) rotate; update the list in `src/garmin/auth.ts` on auth errors.
- **`garth` is discontinued** — the previously common auth library `garth` is no longer maintained; the authoritative reference is `python-garminconnect`.
- **Keep the token folder private** — `~/.garmin-mcp/` holds valid session tokens; don't share it, don't commit it.
- **Terms of service** — access via the unofficial API may be in tension with Garmin's terms of service. Intended for **private personal use** with your **own** data.

## Troubleshooting

- **`403` or a "Just a moment …" page** — Garmin's Cloudflare is blocking the TLS fingerprint. Update the JA3/User-Agent pair in `src/http/impersonate.ts` to a current Chrome (both together), then re-run `npm run smoke`.
- **`🔒 Not logged in` / session expired** — run `npm run login` again.
- **`⏳` rate limited (HTTP 429)** — Garmin is throttling; wait a bit and retry.
- **First run is slow / cycletls errors** — `cycletls` downloads a small Go helper binary on first use; make sure it can execute and isn't blocked by the OS.

## Re-login

If tools report `🔒 Not logged in` (token expired/invalid):

```bash
npm run login
```

## License

[MIT](LICENSE) © Marcel Fortmann

## Disclaimer

This is an unofficial, community project. It is **not affiliated with, endorsed by,
or sponsored by Garmin**. Garmin® and Garmin Connect™ are trademarks of Garmin Ltd.
or its subsidiaries.

# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories
("Report a vulnerability" on the repository's **Security** tab). For non-sensitive
reports you may open a regular issue. Never include real credentials or tokens in a
report.

## Security model

`garmin-mcp` is a local, read-only tool:

- Runs entirely on your machine and speaks to Claude Desktop over **stdio**.
- The only outbound network contact is **Garmin** (over HTTPS).
- Your Garmin **password is never stored** — it is used once, interactively, at login.
- Only OAuth tokens are cached, at `~/.garmin-mcp/tokens.json` with file mode **`0600`**.
- **Read-only**: there is no code path that writes to Garmin.
- No telemetry, no external logging; diagnostics go to `stderr` only.
- No secrets are committed to this repository.

## Disclaimer

This is an unofficial, community project. It is **not affiliated with, endorsed by,
or sponsored by Garmin**. Garmin® and Garmin Connect™ are trademarks of Garmin Ltd.
or its subsidiaries. Use it with your own account and data; access via Garmin's
unofficial API may be in tension with Garmin's terms of service.

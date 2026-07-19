/**
 * Local token cache.
 *
 * Stores the OAuth2 tokens obtained during login (plus the context we need to
 * refresh them) under ~/.garmin-mcp/tokens.json with file mode 0600. The password
 * NEVER touches disk — only the tokens do.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GarminProfile {
  displayName: string;
  fullName?: string;
  userName?: string;
}

export interface StoredTokens {
  /** Bearer access token (JWT) for connectapi.garmin.com. */
  accessToken: string;
  /** Refresh token for the DI-OAuth2 flow. */
  refreshToken: string;
  /** DI client id that the exchange succeeded with (needed on refresh). */
  diClientId: string;
  /** service_url used during login (must be identical on the exchange). */
  serviceUrl: string;
  /** Access-token expiry (Unix seconds, from the JWT `exp`). */
  expiresAt: number;
  /** Optional account profile (display name etc.) so whoami avoids an extra call. */
  profile?: GarminProfile;
}

export const TOKEN_DIR = path.join(os.homedir(), ".garmin-mcp");
export const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.json");

/** Loads the tokens, or null if not logged in yet. */
export async function load(): Promise<StoredTokens | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/** Saves the tokens with restrictive permissions (0600). */
export async function save(tokens: StoredTokens): Promise<void> {
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(tokens, null, 2);
  // mode:0o600 only applies on creation; for an existing file, chmod as well.
  await fs.writeFile(TOKEN_FILE, json, { mode: 0o600 });
  await fs.chmod(TOKEN_FILE, 0o600);
}

/** Clears the token cache (e.g. for a clean re-login). */
export async function clear(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

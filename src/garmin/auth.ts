/**
 * Layer 2 — login flow & token exchange.
 *
 * Ported from the open-source `python-garminconnect` (v0.3.x). Garmin recently
 * changed its auth flow; the old `garth` library is discontinued.
 * `python-garminconnect` therefore tries several login strategies in order. We
 * implement the two most important ones:
 *
 *   A) Mobile iOS JSON login (primary, most reliable path)
 *   B) Widget/CSRF login (fallback — the classic SSO embed flow)
 *
 * Both end with a CAS service ticket (ST-...), which is then exchanged in the
 * modern DI-OAuth2 flow for a bearer access token + refresh token
 * (diauth.garmin.com).
 *
 * MAINTENANCE (fragile): endpoint URLs, client ids, and native app headers can
 * change on Garmin's side. On auth errors, compare against the current source of
 * `python-garminconnect` and update the constants below.
 */
import type { HttpResponse, ImpersonatedHttp } from "../http/impersonate.js";
import {
  GarminAuthError,
  GarminRateLimitError,
  InvalidCredentialsError,
} from "./errors.js";

// --- Hosts -------------------------------------------------------------------
const SSO = "https://sso.garmin.com";
const SSO_BASE = `${SSO}/sso`;
const SSO_EMBED = `${SSO}/sso/embed`;
const SSO_SIGNIN = `${SSO}/sso/signin`;
export const CONNECTAPI = "https://connectapi.garmin.com";
const DIAUTH = "https://diauth.garmin.com";

// --- DI-OAuth2 ---------------------------------------------------------------
const DI_TOKEN_URL = `${DIAUTH}/di-oauth2-service/oauth/token`;
// The grant_type is deliberately a URL (not "password"/"authorization_code").
const DI_SERVICE_TICKET_GRANT =
  "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
// MAINTENANCE: rotating client ids — tried in this order. Prepend new quarterly
// ids (…_2025Q2 etc.) as needed.
const DI_CLIENT_IDS = [
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  "GARMIN_CONNECT_MOBILE_IOS_DI",
];

// --- Native app headers (on all DI/connectapi requests) ----------------------
// MAINTENANCE: occasionally align the version numbers (5.23 / 10861) with the real app.
export const NATIVE_HEADERS: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};

// --- Strategy A: mobile iOS --------------------------------------------------
const MOBILE_CLIENT_ID = "GCM_IOS_DARK";
const MOBILE_SERVICE = "https://mobile.integration.garmin.com/gcm/ios";
const MOBILE_LOGIN_URL = `${SSO}/mobile/api/login`;
const MOBILE_MFA_URL = `${SSO}/mobile/api/mfa/verifyCode`;
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
// Headers for the iOS JSON endpoints (login + mfa/verifyCode). Content-Type must
// be explicit here because these requests send a raw JSON `body` (not `form`).
const IOS_JSON_HEADERS: Record<string, string> = {
  "User-Agent": IOS_UA,
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: SSO,
};

// --- Strategy B: widget/CSRF -------------------------------------------------
const WIDGET_MFA_URL = `${SSO}/sso/verifyMFA/loginEnterMfaCode`;
const EMBED_PARAMS = {
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: SSO_BASE,
};
const SIGNIN_PARAMS = {
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: SSO_EMBED,
  service: SSO_EMBED,
  source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED,
  redirectAfterAccountCreationUrl: SSO_EMBED,
};

// --- Regexes -----------------------------------------------------------------
const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TITLE_RE = /<title>(.+?)<\/title>/i;
const TICKET_RE = /\?ticket=(ST-[^"&\s]+)/;

// --- Types & errors ----------------------------------------------------------
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  diClientId: string;
  serviceUrl: string;
  expiresAt: number;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Callback that supplies the code when MFA is active (e.g. terminal input). */
export type MfaCodeProvider = (method: string) => Promise<string>;

// --- Public API --------------------------------------------------------------

/**
 * Runs the full login: strategy A (mobile) with a fallback to strategy B
 * (widget), then the DI-OAuth2 ticket exchange.
 */
export async function login(
  http: ImpersonatedHttp,
  email: string,
  password: string,
  getMfaCode?: MfaCodeProvider,
): Promise<LoginResult> {
  let ticket: string;
  let serviceUrl: string;

  try {
    const r = await mobileLogin(http, email, password, getMfaCode);
    ticket = r.ticket;
    serviceUrl = r.serviceUrl;
  } catch (err) {
    // Wrong credentials: do not fall back.
    if (err instanceof InvalidCredentialsError) throw err;
    warn(`Mobile login failed (${errMsg(err)}); trying widget flow ...`);
    const r = await widgetLogin(http, email, password, getMfaCode);
    ticket = r.ticket;
    serviceUrl = r.serviceUrl;
  }

  return exchangeTicket(http, ticket, serviceUrl);
}

/** Renews the access token via the refresh token (DI-OAuth2). */
export async function refresh(
  http: ImpersonatedHttp,
  refreshToken: string,
  diClientId: string,
): Promise<RefreshResult> {
  const res = await postDiToken(http, diClientId, {
    grant_type: "refresh_token",
    client_id: diClientId,
    refresh_token: refreshToken,
  });

  const json = res.json as DiTokenResponse | undefined;
  if (isOk(res.status) && json?.access_token) {
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: tokenExpiry(json),
    };
  }
  if (res.status === 429) {
    throw new GarminRateLimitError(
      "Garmin is throttling (HTTP 429). Please try again later.",
    );
  }
  throw new GarminAuthError(
    `Token refresh failed (HTTP ${res.status}). Please run 'npm run login' again.`,
  );
}

// --- Strategy A: mobile iOS JSON ---------------------------------------------

async function mobileLogin(
  http: ImpersonatedHttp,
  email: string,
  password: string,
  getMfaCode?: MfaCodeProvider,
): Promise<{ ticket: string; serviceUrl: string }> {
  const params = {
    clientId: MOBILE_CLIENT_ID,
    locale: "en-US",
    service: MOBILE_SERVICE,
  };

  // Best-effort: load the sign-in page to set cookies.
  await http
    .get(`${SSO}/mobile/sso/en/sign-in`, {
      params: { clientId: MOBILE_CLIENT_ID },
      userAgent: IOS_UA,
    })
    .catch(() => undefined);

  const res = await http.post(MOBILE_LOGIN_URL, {
    params,
    headers: IOS_JSON_HEADERS,
    body: JSON.stringify({
      username: email,
      password,
      rememberMe: true,
      captchaToken: "",
    }),
  });

  const json = res.json as MobileLoginResponse | undefined;
  const type = json?.responseStatus?.type;

  if (!type) {
    // No usable JSON (e.g. Cloudflare HTML / 403) -> trigger the fallback.
    throw new GarminAuthError(`unexpected response (HTTP ${res.status})`);
  }
  if (type === "INVALID_USERNAME_PASSWORD") {
    throw new InvalidCredentialsError("Wrong email or password.");
  }
  if (type === "MFA_REQUIRED") {
    const method = json?.customerMfaInfo?.mfaLastMethodUsed ?? "email";
    const code = await requireMfaCode(getMfaCode, method);
    const ticket = await mobileVerifyMfa(http, params, method, code);
    return { ticket, serviceUrl: MOBILE_SERVICE };
  }
  if (type === "SUCCESSFUL" && json?.serviceTicketId) {
    return { ticket: json.serviceTicketId, serviceUrl: MOBILE_SERVICE };
  }
  throw new GarminAuthError(`unexpected status "${type}" (HTTP ${res.status})`);
}

async function mobileVerifyMfa(
  http: ImpersonatedHttp,
  params: Record<string, string>,
  method: string,
  code: string,
): Promise<string> {
  const res = await http.post(MOBILE_MFA_URL, {
    params,
    headers: IOS_JSON_HEADERS,
    body: JSON.stringify({
      mfaMethod: method,
      mfaVerificationCode: code,
      rememberMyBrowser: true,
      reconsentList: [],
      mfaSetup: false,
    }),
  });

  const json = res.json as MobileLoginResponse | undefined;
  if (json?.serviceTicketId) return json.serviceTicketId;
  if (json?.responseStatus?.type === "INVALID_MFA_CODE") {
    throw new InvalidCredentialsError("Wrong MFA code.");
  }
  throw new GarminAuthError(`MFA verification failed (HTTP ${res.status}).`);
}

// --- Strategy B: widget / CSRF -----------------------------------------------

async function widgetLogin(
  http: ImpersonatedHttp,
  email: string,
  password: string,
  getMfaCode?: MfaCodeProvider,
): Promise<{ ticket: string; serviceUrl: string }> {
  // 1) Load the SSO embed (cookies).
  await http.get(SSO_EMBED, { params: EMBED_PARAMS });

  // 2) Fetch the signin page and parse the CSRF token.
  const signinGet = await http.get(SSO_SIGNIN, {
    params: SIGNIN_PARAMS,
    headers: { Referer: SSO_EMBED },
  });
  const csrf = parse(CSRF_RE, signinGet.text, "CSRF token");

  // 3) Submit credentials.
  const signinUrl = withParams(SSO_SIGNIN, SIGNIN_PARAMS);
  const post = await http.post(SSO_SIGNIN, {
    params: SIGNIN_PARAMS,
    headers: { Referer: signinUrl },
    form: { username: email, password, embed: "true", _csrf: csrf },
  });

  const title = (post.text.match(TITLE_RE)?.[1] ?? "").toLowerCase();

  // 4) MFA?
  if (title.includes("mfa") || title.includes("authentication application")) {
    const csrf2 = parse(CSRF_RE, post.text, "CSRF token (MFA)");
    const code = await requireMfaCode(getMfaCode, "widget");
    const mfaRes = await http.post(WIDGET_MFA_URL, {
      params: SIGNIN_PARAMS,
      headers: { Referer: signinUrl },
      form: {
        "mfa-code": code,
        embed: "true",
        _csrf: csrf2,
        fromPage: "setupEnterMfaCode",
      },
    });
    const ticket = TICKET_RE.exec(mfaRes.text)?.[1];
    if (!ticket) throw new GarminAuthError("No service ticket after MFA.");
    return { ticket, serviceUrl: SSO_EMBED };
  }

  if (/locked|invalid|incorrect/.test(title)) {
    throw new InvalidCredentialsError("Login rejected (locked/invalid).");
  }

  // 5) Success -> service ticket.
  const ticket = TICKET_RE.exec(post.text)?.[1];
  if (!ticket) {
    throw new GarminAuthError(
      `No service ticket received (response title: "${title || "?"}").`,
    );
  }
  return { ticket, serviceUrl: SSO_EMBED };
}

// --- Shared: DI-OAuth2 ticket exchange ---------------------------------------

async function exchangeTicket(
  http: ImpersonatedHttp,
  ticket: string,
  serviceUrl: string,
): Promise<LoginResult> {
  let lastError = "unknown";
  for (const clientId of DI_CLIENT_IDS) {
    try {
      const res = await postDiToken(http, clientId, {
        client_id: clientId,
        service_ticket: ticket,
        grant_type: DI_SERVICE_TICKET_GRANT,
        service_url: serviceUrl,
      });

      const json = res.json as DiTokenResponse | undefined;
      if (isOk(res.status) && json?.access_token && json.refresh_token) {
        return {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          diClientId: clientId,
          serviceUrl,
          expiresAt: tokenExpiry(json),
        };
      }
      lastError = `HTTP ${res.status} with ${clientId}`;
    } catch (err) {
      lastError = `${clientId}: ${errMsg(err)}`;
    }
  }
  throw new GarminAuthError(`DI-OAuth2 ticket exchange failed (${lastError}).`);
}

// --- Response types ----------------------------------------------------------
interface MobileLoginResponse {
  responseStatus?: { type?: string };
  serviceTicketId?: string;
  customerMfaInfo?: { mfaLastMethodUsed?: string };
}
interface DiTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

// --- Helpers -----------------------------------------------------------------

async function requireMfaCode(
  getMfaCode: MfaCodeProvider | undefined,
  method: string,
): Promise<string> {
  if (!getMfaCode) {
    throw new GarminAuthError(
      "MFA is active, but no code provider was supplied.",
    );
  }
  return getMfaCode(method);
}

function basicAuth(clientId: string): string {
  // Client id as the username, EMPTY password — the DI flow uses no secret.
  return Buffer.from(`${clientId}:`).toString("base64");
}

/**
 * POSTs a form to the DI-OAuth2 token endpoint with the standard headers (native
 * app headers + Basic auth of the client id). The single place this endpoint is
 * called — so headers/URL stay consistent between the ticket exchange and refresh.
 * Content-Type (x-www-form-urlencoded) is set automatically by the HTTP layer for `form`.
 */
function postDiToken(
  http: ImpersonatedHttp,
  clientId: string,
  form: Record<string, string>,
): Promise<HttpResponse> {
  return http.post(DI_TOKEN_URL, {
    headers: {
      ...NATIVE_HEADERS,
      Authorization: `Basic ${basicAuth(clientId)}`,
      "Cache-Control": "no-cache",
    },
    form,
  });
}

/** Expiry (Unix seconds) from the JWT `exp`, else from expires_in. */
function tokenExpiry(json: DiTokenResponse): number {
  const exp = json.access_token ? decodeJwtExp(json.access_token) : null;
  if (exp) return exp;
  const now = Math.floor(Date.now() / 1000);
  return now + (json.expires_in ?? 3600);
}

export function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

function withParams(url: string, params: Record<string, string>): string {
  const usp = new URLSearchParams(params);
  return `${url}?${usp.toString()}`;
}

function parse(re: RegExp, text: string, what: string): string {
  const m = re.exec(text);
  if (!m) throw new GarminAuthError(`${what} not found in the response.`);
  return m[1];
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// stderr is fine (local only, no external logging); stdout stays free for MCP.
function warn(msg: string): void {
  process.stderr.write(`[garmin-mcp] ${msg}\n`);
}

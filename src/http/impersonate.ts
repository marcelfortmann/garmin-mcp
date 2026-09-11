/**
 * Layer 1 — HTTP / Cloudflare layer.
 *
 * A thin wrapper around `cycletls` that gives every request a browser-like TLS
 * fingerprint (JA3) plus a matching User-Agent. This is required so that Garmin's
 * Cloudflare/bot protection does not flag us as a script. The wrapper also keeps a
 * small cookie jar (collect Set-Cookie, send it back as a Cookie header) — the SSO
 * login depends on this.
 */

// --- Fragile import (NodeNext + CommonJS) ------------------------------------
// `cycletls` is a CommonJS module; its default export IS the init function
// (`module.exports = initCycleTLS`). Under `moduleResolution: NodeNext`,
// TypeScript mis-types the default import as a namespace, so it appears to be
// non-callable. We therefore re-type the default import to its real signature
// `(opts?) => Promise<CycleTLSClient>`.
import initCycleTLSModule from "cycletls";
import type {
  CycleTLSClient,
  CycleTLSRequestOptions,
  CycleTLSResponse,
} from "cycletls";

const initCycleTLS = initCycleTLSModule as unknown as (initOptions?: {
  port?: number;
  debug?: boolean;
  timeout?: number;
  executablePath?: string;
  autoExit?: boolean;
}) => Promise<CycleTLSClient>;

// --- Maintainable fingerprint constants --------------------------------------
// MAINTENANCE: On a 403 or a "Just a moment ..." Cloudflare page, update this
// pair to a current Chrome. JA3 and User-Agent must match each other (same Chrome
// major version) — a fresh UA on a stale fingerprint is a *stronger* bot signal
// than a consistent old pair. Sources for current JA3 strings: e.g. open
// tls.peet.ws / ja3er.com in real Chrome.
//
// The extension list carries what a modern Chrome sends: 27 (compress_certificate),
// 17513 (ALPS) and 65037 (ECH). The first supported group is 4588
// (X25519MLKEM768) — Chrome's post-quantum key share, sent since Chrome 131.
// Verify any change with `npm run smoke` before committing it.
export const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-5-10-11-13-16-18-23-27-35-43-45-51-17513-65037-65281,4588-29-23-24,0";
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// NOTE: cycletls has TWO different timeouts with different units:
//  - The init timeout (initCycleTLS) is the wait, in MILLISECONDS, for the Node
//    process to connect to the spawned Go helper over a WebSocket.
//    (cycletls default 20000ms; values too small -> "Failed to initialize CycleTLS".)
//  - The request timeout (per request) is in SECONDS and bounds the actual HTTP
//    request on the Go side (cycletls default 7s).
const INIT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_SECONDS = 30;

export interface RequestOptions {
  /** Query parameters appended to the URL. */
  params?: Record<string, string | number | boolean | undefined>;
  /** x-www-form-urlencoded body (mutually exclusive with `body`). */
  form?: Record<string, string | number | boolean | undefined>;
  /** Raw body (e.g. a JSON string); only used when `form` is not set. */
  body?: string;
  /** Additional/overriding headers. */
  headers?: Record<string, string>;
  /** User-Agent for this request (default: CHROME_UA). */
  userAgent?: string;
  /** Do not follow redirects (for ticket/cookie extraction). */
  disableRedirect?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, unknown>;
  /** Response body as text. */
  text: string;
  /** Parsed JSON, if the body was valid JSON. */
  json?: unknown;
  /** Final URL after redirects. */
  finalUrl: string;
}

export class ImpersonatedHttp {
  private client: CycleTLSClient | null = null;
  private readonly cookieJar = new Map<string, string>();

  /** Lazily spawns the cycletls helper process on the first request. */
  private async getClient(): Promise<CycleTLSClient> {
    if (!this.client) {
      // timeout = WS-connect window in MILLISECONDS (see note above).
      this.client = await initCycleTLS({ timeout: INIT_TIMEOUT_MS });
    }
    return this.client;
  }

  async get(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request("get", url, opts);
  }

  async post(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request("post", url, opts);
  }

  private async request(
    method: "get" | "post",
    url: string,
    opts: RequestOptions,
  ): Promise<HttpResponse> {
    const client = await this.getClient();
    const finalUrl = appendParams(url, opts.params);

    // Build headers case-insensitively; handle User-Agent separately so it is
    // not sent twice (cycletls has a dedicated option for it).
    const headers: Record<string, string> = {};
    let userAgent = opts.userAgent ?? CHROME_UA;
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (k.toLowerCase() === "user-agent") {
        userAgent = v;
        continue;
      }
      headers[k] = v;
    }

    // Body: form (urlencoded) takes precedence over a raw body.
    let body: string | undefined = opts.body;
    if (opts.form) {
      body = toSearchParams(opts.form).toString();
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    // Send the cookie jar along (unless explicitly overridden).
    const cookieHeader = this.cookieHeader();
    if (cookieHeader && !hasHeader(headers, "cookie")) {
      headers["Cookie"] = cookieHeader;
    }

    const requestOptions: CycleTLSRequestOptions = {
      ja3: CHROME_JA3,
      userAgent,
      headers,
      body: body ?? "",
      disableRedirect: opts.disableRedirect,
      // responseType 'text' forces a string in `data`. Without it, cycletls
      // tries to JSON-parse by default and returns a raw Buffer for HTML — we
      // parse JSON ourselves in normalizeResponse() instead.
      responseType: "text",
      // request timeout in SECONDS (Go side).
      timeout: REQUEST_TIMEOUT_SECONDS,
    };

    const res: CycleTLSResponse = await client(finalUrl, requestOptions, method);

    this.collectCookies(res.headers);
    return normalizeResponse(res, finalUrl);
  }

  /** Builds the current Cookie header from the jar. */
  private cookieHeader(): string {
    return Array.from(this.cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  /** Collects Set-Cookie headers (string or array). */
  private collectCookies(headers: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "set-cookie") continue;
      const list = Array.isArray(value) ? value : [value];
      for (const raw of list) {
        if (typeof raw !== "string") continue;
        // "NAME=VALUE; Path=/; HttpOnly" -> keep only NAME=VALUE.
        const first = raw.split(";", 1)[0];
        const eq = first.indexOf("=");
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const val = first.slice(eq + 1).trim();
        if (name) this.cookieJar.set(name, val);
      }
    }
  }

  /** Cleanly shuts down the cycletls helper process. */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.exit();
      this.client = null;
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** Builds URLSearchParams from a record, skipping undefined values. */
export function toSearchParams(
  record: Record<string, string | number | boolean | undefined>,
): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) usp.append(k, String(v));
  }
  return usp;
}

function appendParams(
  url: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return url;
  const qs = toSearchParams(params).toString();
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function normalizeResponse(
  res: CycleTLSResponse,
  finalUrl: string,
): HttpResponse {
  // cycletls returns the body in `data` — depending on content type either a
  // string or an already-parsed object. We normalize both to text (+ optional json).
  const data: unknown = res.data;
  let text: string;
  let json: unknown;

  if (typeof data === "string") {
    text = data;
    try {
      json = JSON.parse(data);
    } catch {
      json = undefined;
    }
  } else if (data === undefined || data === null) {
    text = "";
  } else {
    json = data;
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }

  return {
    status: res.status,
    headers: res.headers ?? {},
    text,
    json,
    finalUrl: res.finalUrl ?? finalUrl,
  };
}

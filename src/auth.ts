import { randomBytes } from "crypto";
import { CliError, toCliError } from "./errors";
import { loadConfig, saveConfig, type Config } from "./config";

/**
 * Credential resolution and login flows.
 *
 * Token precedence: TICKTICK_TOKEN env var, then the token saved in config.json
 * (a personal API token or an OAuth access token). The Open API documents only the
 * authorization_code grant, so there is no refresh: an expired OAuth token means
 * logging in again. Personal tokens do not expire until revoked.
 *
 * Nothing in this module prints tokens, client secrets, or authorization codes.
 */

export const OAUTH_BASE = () => process.env.TICKTICK_OAUTH_BASE ?? "https://ticktick.com/oauth";
export const API_HOST = () => process.env.TICKTICK_API_HOST ?? "https://api.ticktick.com";
const SCOPE = "tasks:read tasks:write";
const DEFAULT_REDIRECT = "http://localhost:8080";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export type TokenSource = "env" | "personal" | "oauth";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  expiresAt?: number;
}

export async function resolveToken(now = Date.now()): Promise<ResolvedToken> {
  const env = process.env.TICKTICK_TOKEN?.trim();
  if (env) return { token: env, source: "env" };
  const config = await loadConfig();
  if (!config.accessToken) {
    throw new CliError("AUTH_REQUIRED", "Not authenticated. Run `ticktick auth token` (personal API token) or `ticktick auth login` (OAuth), or set TICKTICK_TOKEN.");
  }
  const source: TokenSource = config.tokenSource === "oauth" ? "oauth" : "personal";
  if (config.tokenExpiresAt !== undefined && now >= config.tokenExpiresAt) {
    throw new CliError("AUTH_EXPIRED", "The saved OAuth token has expired. Run `ticktick auth login` again or switch to a personal API token with `ticktick auth token`.");
  }
  return { token: config.accessToken, source, ...(config.tokenExpiresAt !== undefined ? { expiresAt: config.tokenExpiresAt } : {}) };
}

export async function savePersonalToken(token: string): Promise<void> {
  const config = await loadConfig();
  config.accessToken = token;
  config.tokenSource = "personal";
  delete config.tokenExpiresAt;
  await saveConfig(config);
}

export async function clearToken(): Promise<boolean> {
  const config = await loadConfig();
  const had = Boolean(config.accessToken);
  delete config.accessToken;
  delete config.tokenSource;
  delete config.tokenExpiresAt;
  await saveConfig(config);
  return had;
}

/** Revokes a token server-side (POST /oauth/revoke). */
export async function revokeToken(token: string): Promise<void> {
  const form = new FormData();
  form.set("token", token);
  const res = await fetch(`${API_HOST()}/oauth/revoke`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) }).catch(() => {
    throw new CliError("NETWORK_ERROR", "Could not reach TickTick to revoke the token.");
  });
  if (!res.ok) throw new CliError("API_ERROR", `Token revocation failed with HTTP ${res.status}.`);
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Merges flags/env into saved OAuth client settings and persists them. */
export async function oauthClient(flags: { clientId?: string; clientSecret?: string; redirectUri?: string }): Promise<OAuthClient> {
  const config = await loadConfig();
  const clientId = flags.clientId ?? process.env.TICKTICK_CLIENT_ID ?? config.clientId;
  const clientSecret = flags.clientSecret ?? process.env.TICKTICK_CLIENT_SECRET ?? config.clientSecret;
  const redirectUri = flags.redirectUri ?? config.redirectUri ?? DEFAULT_REDIRECT;
  if (!clientId || !clientSecret) {
    throw new CliError("INVALID_ARGUMENT", "OAuth needs a client id and secret: pass --client-id/--client-secret or set TICKTICK_CLIENT_ID/TICKTICK_CLIENT_SECRET. Register an app at https://developer.ticktick.com/manage.");
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new CliError("INVALID_ARGUMENT", `Invalid redirect URI: ${redirectUri}`);
  }
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new CliError("INVALID_ARGUMENT", "The redirect URI must be http://localhost:<port> or http://127.0.0.1:<port>.");
  }
  if (config.clientId !== clientId || config.clientSecret !== clientSecret || config.redirectUri !== redirectUri) {
    await saveConfig({ ...config, clientId, clientSecret, redirectUri });
  }
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(client: OAuthClient, state: string): string {
  const params = new URLSearchParams({ client_id: client.clientId, scope: SCOPE, state, redirect_uri: client.redirectUri, response_type: "code" });
  return `${OAUTH_BASE()}/authorize?${params}`;
}

const newState = () => randomBytes(16).toString("hex");

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const page = (title: string, body: string) =>
  `<!doctype html><html><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p>You can close this window.</p></body></html>`;

/** Reads `code` from a redirect URL after checking `state`. Never echoes the URL. */
export function codeFromRedirect(redirect: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(redirect.trim());
  } catch {
    throw new CliError("INVALID_ARGUMENT", "That is not a valid URL. Paste the full address from the browser bar after authorizing.");
  }
  const error = url.searchParams.get("error");
  if (error) throw new CliError("AUTH_INVALID", `TickTick returned an OAuth error: ${error.replace(/[^\w.-]/g, "").slice(0, 60)}`);
  if (url.searchParams.get("state") !== expectedState) {
    throw new CliError("AUTH_INVALID", "OAuth state mismatch. Start the login again and use the newest authorization URL.");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new CliError("AUTH_INVALID", "The redirect URL has no authorization code.");
  return code;
}

/** Exchanges an authorization code for a token and saves it. */
export async function exchangeCode(client: OAuthClient, code: string, now = Date.now()): Promise<{ expiresAt?: number }> {
  const res = await fetch(`${OAUTH_BASE()}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: client.redirectUri, scope: SCOPE }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new CliError("NETWORK_ERROR", "Could not reach TickTick to exchange the authorization code.");
  });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== "string") {
    const reason = typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? ` (${body.error})` : "";
    throw new CliError("AUTH_INVALID", `Token exchange failed with HTTP ${res.status}${reason}. Check the client id, secret, and redirect URI.`);
  }
  const config: Config = await loadConfig();
  config.accessToken = body.access_token;
  config.tokenSource = "oauth";
  if (typeof body.expires_in === "number") config.tokenExpiresAt = now + body.expires_in * 1000;
  else delete config.tokenExpiresAt;
  await saveConfig(config);
  return config.tokenExpiresAt !== undefined ? { expiresAt: config.tokenExpiresAt } : {};
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed as well; failing to launch a browser is not an error.
  }
}

/** Loopback OAuth: listens on 127.0.0.1 only and waits for TickTick's redirect. */
export async function loginWithBrowser(client: OAuthClient, notify: (msg: string) => void): Promise<string> {
  const state = newState();
  const port = Number(new URL(client.redirectUri).port || 80);
  let settle!: { resolve: (code: string) => void; reject: (e: CliError) => void };
  const result = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== (new URL(client.redirectUri).pathname || "/")) return new Response("Not found", { status: 404 });
      try {
        const code = codeFromRedirect(url.toString(), state);
        settle.resolve(code);
        return new Response(page("Authentication complete", "Return to the terminal."), { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        const err = toCliError(e);
        settle.reject(err);
        return new Response(page("Authentication failed", err.message), { status: 400, headers: { "Content-Type": "text/html" } });
      }
    },
  });
  const timer = setTimeout(() => settle.reject(new CliError("AUTH_INVALID", "Timed out waiting for the browser redirect.")), LOGIN_TIMEOUT_MS);
  const url = authorizeUrl(client, state);
  notify(`Open this URL to authorize (listening on 127.0.0.1:${port}):\n${url}`);
  openBrowser(url);
  try {
    return await result;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

/** Headless OAuth: print the URL, then read the pasted redirect URL from stdin. */
export async function loginManually(client: OAuthClient, notify: (msg: string) => void, readLine: () => Promise<string>): Promise<string> {
  const state = newState();
  notify(`Open this URL on any device, authorize, then paste the full redirect URL here:\n${authorizeUrl(client, state)}`);
  const pasted = await readLine();
  if (!pasted.trim()) throw new CliError("INVALID_ARGUMENT", "No redirect URL was provided.");
  return codeFromRedirect(pasted, state);
}

/** Reads one line from stdin (used for pasted URLs and tokens). */
export async function readStdinLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("\n")) break;
    }
  } finally {
    reader.releaseLock();
  }
  return text.split("\n")[0]!.trim();
}

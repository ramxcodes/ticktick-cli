import { ApiClient } from "../http";
import { TickTickApi } from "../api";
import {
  API_HOST,
  clearToken,
  exchangeCode,
  loginManually,
  loginWithBrowser,
  oauthClient,
  readStdinLine,
  resolveToken,
  revokeToken,
  savePersonalToken,
} from "../auth";
import { configDir } from "../config";
import { CliError, toCliError } from "../errors";
import type { Runtime } from "../runtime";

/** Checks a token with one cheap read. */
async function probeToken(token: string): Promise<void> {
  const client = new ApiClient({ baseUrl: process.env.TICKTICK_API_BASE ?? `${API_HOST()}/open/v1`, getToken: async () => token, maxRetries: 1 });
  await new TickTickApi(client).listProjects();
}

const expiry = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

/** `auth token`: saves a personal API token read from stdin (never from argv). */
export async function authToken(rt: Runtime): Promise<void> {
  if (process.stdin.isTTY) process.stderr.write("Paste your TickTick API token (Settings → Account → API Token): ");
  const token = await readStdinLine();
  if (!token) throw new CliError("INVALID_ARGUMENT", "No token on stdin. Example: printf '%s' \"$TOKEN\" | ticktick auth token");
  await probeToken(token);
  await savePersonalToken(token);
  rt.out.success({ authenticated: true, source: "personal", configDir: configDir() }, () => "✓ Personal API token saved and verified.", rt.metaSources());
}

export async function authLogin(rt: Runtime, opts: { clientId?: string; clientSecret?: string; redirectUri?: string; manual?: boolean }): Promise<void> {
  const client = await oauthClient(opts);
  const notify = (m: string) => process.stderr.write(`${m}\n`);
  const code = opts.manual ? await loginManually(client, notify, readStdinLine) : await loginWithBrowser(client, notify);
  const { expiresAt } = await exchangeCode(client, code);
  rt.out.success({ authenticated: true, source: "oauth", expiresAt: expiry(expiresAt) }, () => `✓ Logged in with OAuth${expiresAt ? `; token expires ${expiry(expiresAt)}` : ""}.`, rt.metaSources());
}

export async function authStatus(rt: Runtime): Promise<void> {
  let resolved;
  try {
    resolved = await resolveToken(rt.now);
  } catch (error) {
    const e = toCliError(error);
    if (e.code === "AUTH_REQUIRED" || e.code === "AUTH_EXPIRED") {
      return rt.out.success({ authenticated: false, reason: e.code, configDir: configDir() }, () => `✗ ${e.message}`, rt.metaSources());
    }
    throw e;
  }
  let valid = true;
  let reason: string | undefined;
  try {
    await probeToken(resolved.token);
  } catch (error) {
    const e = toCliError(error);
    if (e.code !== "AUTH_INVALID") throw e;
    valid = false;
    reason = e.code;
  }
  const data = { authenticated: valid, source: resolved.source, expiresAt: expiry(resolved.expiresAt), configDir: configDir(), ...(reason ? { reason } : {}) };
  rt.out.success(data, (d) => (d.authenticated ? `✓ Authenticated (${d.source})${d.expiresAt ? `, expires ${d.expiresAt}` : ""}` : `✗ Token rejected by TickTick (${d.source}). Log in again.`), rt.metaSources());
}

export async function authLogout(rt: Runtime, opts: { revoke?: boolean }): Promise<void> {
  if (process.env.TICKTICK_TOKEN) rt.out.warn("TICKTICK_TOKEN is set in the environment; unset it as well.");
  let revoked = false;
  if (opts.revoke) {
    const { token } = await resolveToken(rt.now);
    await revokeToken(token);
    revoked = true;
  }
  const removed = await clearToken();
  rt.out.success({ removed, revoked }, () => `✓ ${removed ? "Removed the saved token" : "No saved token"}${revoked ? " and revoked it" : ""}.`, rt.metaSources());
}

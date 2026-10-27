import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Preloaded by `bun test` (see bunfig.toml). Keeps every in-process test away from real
 * TickTick data: fetch may only reach loopback hosts (the fake server), the config dir is a
 * throwaway temp dir, and real credentials from the shell are dropped.
 * E2E tests spawn the CLI with an explicit env, so they do not inherit any of this.
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) {
    const message = `Blocked network access in tests: ${url}. Inject a fake fetch or use the fake server.`;
    console.error(message);
    throw new Error(message);
  }
  return realFetch(input, init);
}, realFetch);

const configDir = mkdtempSync(join(tmpdir(), "tt-suite-"));
process.env.TICKTICK_CONFIG_DIR = configDir;
for (const key of ["TICKTICK_TOKEN", "TICKTICK_CLIENT_ID", "TICKTICK_CLIENT_SECRET", "TICKTICK_API_BASE", "TICKTICK_API_HOST", "TICKTICK_OAUTH_BASE"]) {
  delete process.env[key];
}

afterAll(() => rmSync(configDir, { recursive: true, force: true }));

import { lstat, chmod, mkdir, open, readFile, rename, unlink, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { CliError } from "./errors";

/**
 * Local state: config.json (credentials, settings) and ops.json (idempotency ledger).
 * Directory is forced to 0700 and files to 0600. Symlinks and files owned by
 * another user are rejected before anything is read or written.
 */

export interface Config {
  accessToken?: string;
  tokenSource?: "oauth" | "personal";
  /** Epoch ms. Only set for OAuth tokens. */
  tokenExpiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  timezone?: string;
}

/** Keys users may change with `ticktick config set`. */
export const SETTABLE_KEYS = ["timezone"] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

export function configDir(): string {
  if (process.env.TICKTICK_CONFIG_DIR) return process.env.TICKTICK_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ticktick-cli");
}

export const configFile = () => join(configDir(), "config.json");

/** Collects non-fatal notices (e.g. repaired permissions) for meta.warnings. */
export const securityNotices: string[] = [];

type PathKind = "dir" | "file";

/** Validates an existing path and tightens its mode. Returns false when missing. */
async function securePath(path: string, kind: PathKind): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (info.isSymbolicLink()) {
    throw new CliError("INSECURE_CREDENTIALS", `Refusing to use symlink: ${path}`);
  }
  if (kind === "dir" ? !info.isDirectory() : !info.isFile()) {
    throw new CliError("INSECURE_CREDENTIALS", `Expected a ${kind === "dir" ? "directory" : "regular file"}: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new CliError("INSECURE_CREDENTIALS", `${path} is owned by another user (uid ${info.uid}).`);
  }
  const wanted = kind === "dir" ? 0o700 : 0o600;
  if ((info.mode & 0o777) !== wanted) {
    await chmod(path, wanted);
    securityNotices.push(`Fixed permissions on ${path}: ${(info.mode & 0o777).toString(8)} -> ${wanted.toString(8)}`);
  }
  return true;
}

export async function ensureConfigDir(): Promise<string> {
  const dir = configDir();
  if (!(await securePath(dir, "dir"))) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  return dir;
}

/** Reads a JSON file from the config dir. Returns undefined when it does not exist. */
export async function readSecureJson<T>(name: string): Promise<T | undefined> {
  const dir = configDir();
  if (!(await securePath(dir, "dir"))) return undefined;
  const file = join(dir, name);
  if (!(await securePath(file, "file"))) return undefined;
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError("INVALID_CONFIG", `${file} is not valid JSON.`);
  }
}

/** Atomically replaces a JSON file in the config dir (write temp 0600, fsync, rename). */
export async function writeSecureJson(name: string, value: unknown): Promise<void> {
  const dir = await ensureConfigDir();
  const file = join(dir, name);
  await securePath(file, "file");
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export async function loadConfig(): Promise<Config> {
  return (await readSecureJson<Config>("config.json")) ?? {};
}

export async function saveConfig(config: Config): Promise<void> {
  await writeSecureJson("config.json", config);
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;

/**
 * Runs `fn` while holding an exclusive lock file in the config dir.
 * Used to serialise idempotency-ledger updates across concurrent processes.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const dir = await ensureConfigDir();
  const lockPath = join(dir, `${name}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new CliError("CONFLICT", `Another ticktick process holds ${lockPath}. Try again shortly.`);
      }
      await Bun.sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

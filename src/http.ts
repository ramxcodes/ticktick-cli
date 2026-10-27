import type { ReadCache } from "./cache";
import { CliError } from "./errors";

/**
 * The single HTTP path to the TickTick Open API.
 *
 * Retry policy:
 * - Reads retry on network errors, timeouts, 429 and 5xx (exponential backoff, full jitter,
 *   Retry-After honoured).
 * - Writes retry only on rate-limit rejections (429 / exceed_query_limit), where the server
 *   refused the request. A timeout, network error or other 5xx on a write throws
 *   UNCERTAIN_WRITE: the write may or may not have happened, so it is never repeated blindly.
 */

export type RequestKind = "read" | "write";

export interface ClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  maxRetries?: number;
  /** Refuse every write (dry-run safety net). */
  readOnly?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onDiagnostic?: (message: string) => void;
  /** Optional cross-command cache for GET responses (read-only commands only). */
  cache?: ReadCache;
}

export interface RequestStats {
  count: number;
  retries: number;
  writes: number;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

export class ApiClient {
  readonly stats: RequestStats = { count: 0, retries: 0, writes: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly memo = new Map<string, Promise<unknown>>();
  private active = 0;
  /** After a rate-limit answer every request waits until this time (shared back-off). */
  private pausedUntil = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.random = options.random ?? Math.random;
  }

  get<T>(path: string): Promise<T> {
    // GETs are memoised for the life of one command: identical reads hit the network once.
    const cached = this.memo.get(path);
    if (cached) return cached as Promise<T>;
    const pending = this.cachedGet<T>(path);
    this.memo.set(path, pending);
    pending.catch(() => this.memo.delete(path));
    return pending;
  }

  private async cachedGet<T>(path: string): Promise<T> {
    const cache = this.options.cache;
    const hit = cache ? await cache.get(path) : undefined;
    if (hit !== undefined) return hit as T;
    const body = await this.request<T>("GET", path, undefined, "read");
    await cache?.set(path, body);
    return body;
  }

  /** POST endpoints that only query data (filter, completed, preference). */
  query<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body, "read");
  }

  write<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (this.options.readOnly) {
      throw new CliError("INTERNAL", `Dry-run blocked a write request: ${method} ${path}`);
    }
    this.memo.clear();
    this.stats.writes++;
    return this.request<T>(method, path, body, "write");
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    return Math.floor(this.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
  }

  private async request<T>(method: string, path: string, body: unknown, kind: RequestKind): Promise<T> {
    const token = await this.options.getToken();
    const label = `${method} ${path.split("?")[0]}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      const paused = this.pausedUntil - Date.now();
      if (paused > 0) await this.sleep(paused);
      await this.acquire();
      try {
        this.stats.count++;
        response = await this.fetchImpl(this.options.baseUrl + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        this.release();
        const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
        const what = timedOut ? `timed out after ${this.timeoutMs} ms` : "failed (network error)";
        if (kind === "write") {
          throw new CliError("UNCERTAIN_WRITE", `${label} ${what}. The change may or may not have been applied. Check the current state before retrying.`);
        }
        if (attempt < this.maxRetries) {
          await this.retryAfter(attempt, null, `${label} ${what}`);
          continue;
        }
        throw new CliError("NETWORK_ERROR", `${label} ${what} after ${attempt + 1} attempts.`);
      }

      let text: string;
      try {
        text = await response.text();
      } finally {
        this.release();
      }

      if (response.ok) {
        if (!text) return null as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new CliError("API_ERROR", `${label} returned a response that is not JSON.`);
        }
      }

      const rateLimited = response.status === 429 || (response.status === 500 && text.includes("exceed_query_limit"));
      if (rateLimited) {
        if (attempt < this.maxRetries) {
          const wait = this.backoff(attempt, response.headers.get("retry-after"));
          this.stats.retries++;
          if (Date.now() + wait > this.pausedUntil) {
            this.pausedUntil = Date.now() + wait;
            this.options.onDiagnostic?.(`rate limited by TickTick; pausing all requests for ${(wait / 1000).toFixed(1)}s`);
          }
          continue;
        }
        throw new CliError("RATE_LIMITED", `TickTick rate limit reached (${label}). Wait a few minutes and try again.`);
      }

      if (response.status >= 500 && kind === "read" && attempt < this.maxRetries) {
        await this.retryAfter(attempt, response.headers.get("retry-after"), `${label} returned HTTP ${response.status}`);
        continue;
      }
      throw this.httpError(response.status, text, label, kind);
    }
  }

  private async retryAfter(attempt: number, retryAfter: string | null, reason: string): Promise<void> {
    const wait = this.backoff(attempt, retryAfter);
    this.stats.retries++;
    this.options.onDiagnostic?.(`${reason}; retrying in ${(wait / 1000).toFixed(1)}s (${attempt + 1}/${this.maxRetries})`);
    await this.sleep(wait);
  }

  private httpError(status: number, text: string, label: string, kind: RequestKind): CliError {
    const detail = describeApiError(text);
    if (status === 401) {
      return new CliError("AUTH_INVALID", "TickTick rejected the access token (expired or revoked). Run `ticktick auth login` or `ticktick auth token`.");
    }
    if (status === 403) return new CliError("PERMISSION_DENIED", `${label}: permission denied${detail}.`, { status });
    if (status === 404) return new CliError("NOT_FOUND", `${label}: not found${detail}.`, { status });
    if (status >= 500 && kind === "write") {
      return new CliError("UNCERTAIN_WRITE", `${label} failed with HTTP ${status}${detail}. The change may or may not have been applied. Check the current state before retrying.`, { status });
    }
    return new CliError("API_ERROR", `${label} failed with HTTP ${status}${detail}.`, { status });
  }
}

/** Extracts the documented error fields only; never echoes the raw body. */
function describeApiError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errorCode?: unknown; errorMessage?: unknown };
    const code = typeof parsed.errorCode === "string" ? parsed.errorCode : undefined;
    const message = typeof parsed.errorMessage === "string" ? parsed.errorMessage.slice(0, 200) : undefined;
    if (code || message) return ` (${[code, message].filter(Boolean).join(": ")})`;
  } catch {
    // Not JSON: say nothing rather than echo arbitrary text.
  }
  return "";
}

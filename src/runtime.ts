import { TickTickApi } from "./api";
import { resolveToken, API_HOST } from "./auth";
import { ReadCache, clearReadCache } from "./cache";
import { loadConfig, securityNotices } from "./config";
import { CliError, toCliError } from "./errors";
import { ApiClient } from "./http";
import { Output, type MetaSources } from "./output";
import { assertTimeZone, isValidTimeZone, machineTimeZone, parsePositiveInt } from "./time";

/** Global flags shared by every command. */
export interface GlobalOptions {
  json?: boolean;
  tz?: string;
  verbose?: boolean;
  dryRun?: boolean;
  cacheTtl?: string;
}

export type TimezoneSource = "flag" | "config" | "account" | "machine";

/**
 * Per-invocation context: lazily creates the API client and resolves the display
 * timezone with precedence --tz > config > TickTick account (/preference) > machine.
 */
export class Runtime {
  readonly out: Output;
  readonly now: number;
  readonly dryRun: boolean;
  private apiInstance?: TickTickApi;
  private client?: ApiClient;
  private cache?: ReadCache;
  private tz?: { name: string; source: TimezoneSource };

  constructor(readonly options: GlobalOptions, now = Date.now()) {
    this.out = new Output(Boolean(options.json));
    this.now = now;
    this.dryRun = Boolean(options.dryRun);
    this.out.dryRun = this.dryRun;
  }

  /**
   * API access. `readCommand` enables the opt-in read cache; mutating commands
   * pass false so their decisions are always based on live data.
   */
  async api(readCommand = false): Promise<TickTickApi> {
    if (this.apiInstance) return this.apiInstance;
    const { token } = await resolveToken(this.now);
    if (readCommand && this.options.cacheTtl !== undefined) {
      this.cache = new ReadCache(parsePositiveInt(this.options.cacheTtl, "--cache-ttl"));
    } else if (this.options.cacheTtl !== undefined) {
      throw new CliError("INVALID_ARGUMENT", "--cache-ttl is only allowed on read-only commands.");
    }
    this.client = new ApiClient({
      baseUrl: process.env.TICKTICK_API_BASE ?? `${API_HOST()}/open/v1`,
      getToken: async () => token,
      timeoutMs: process.env.TICKTICK_TIMEOUT_MS ? Number(process.env.TICKTICK_TIMEOUT_MS) : undefined,
      concurrency: process.env.TICKTICK_CONCURRENCY ? Number(process.env.TICKTICK_CONCURRENCY) : undefined,
      readOnly: this.dryRun,
      cache: this.cache,
      onDiagnostic: (m) => this.out.diagnostic(m),
    });
    this.apiInstance = new TickTickApi(this.client);
    return this.apiInstance;
  }

  async timezone(): Promise<string> {
    return (await this.timezoneInfo()).name;
  }

  async timezoneInfo(): Promise<{ name: string; source: TimezoneSource }> {
    if (this.tz) return this.tz;
    if (this.options.tz) return (this.tz = { name: assertTimeZone(this.options.tz), source: "flag" });
    const saved = (await loadConfig()).timezone;
    if (saved) {
      if (!isValidTimeZone(saved)) throw new CliError("INVALID_CONFIG", `Saved timezone "${saved}" is not a valid IANA zone. Fix it with \`ticktick config set timezone <zone>\`.`);
      return (this.tz = { name: saved, source: "config" });
    }
    try {
      const account = await (await this.api()).preferenceTimeZone();
      if (account && isValidTimeZone(account)) return (this.tz = { name: account, source: "account" });
    } catch (error) {
      const e = toCliError(error);
      if (e.code === "AUTH_REQUIRED" || e.code === "AUTH_INVALID" || e.code === "AUTH_EXPIRED") throw e;
      this.out.warn(`Could not read the TickTick account timezone (${e.code}); using the machine timezone.`);
    }
    return (this.tz = { name: machineTimeZone(), source: "machine" });
  }

  /** Called after any write attempt so cached reads cannot be stale. */
  async invalidateCache(): Promise<void> {
    await clearReadCache().catch(() => {});
  }

  metaSources(): MetaSources {
    for (const notice of securityNotices) this.out.warn(notice);
    return {
      usedApi: Boolean(this.client && this.client.stats.count > 0),
      ...(this.tz ? { timezone: this.tz.name } : {}),
      ...(this.client ? { requests: this.client.stats } : {}),
      ...(this.cache ? { cache: this.cache.stats } : {}),
    };
  }

  async finish(): Promise<void> {
    await this.cache?.flush();
    if (this.client && this.client.stats.writes > 0) await this.invalidateCache();
  }
}

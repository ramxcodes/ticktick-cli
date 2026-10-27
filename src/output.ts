import type { CacheStats } from "./cache";
import type { CliError } from "./errors";
import type { RequestStats } from "./http";

/**
 * The v2 output contract. With --json every command prints exactly one envelope:
 *   { ok: true,  data, meta }            on success (exit 0)
 *   { ok: false, error, meta }           on failure (exit code from errors.ts)
 * Human mode prints text to stdout; warnings and diagnostics always go to stderr.
 */

export type Coverage = "complete" | "partial" | "unknown";

export interface Meta {
  source: "official-open-api" | "local";
  coverage: Coverage;
  timezone?: string;
  fetchedAt: string;
  warnings: string[];
  requests?: RequestStats;
  cache?: CacheStats;
  dryRun?: boolean;
}

export type Envelope<T> =
  | { ok: true; data: T; meta: Meta }
  | { ok: false; error: { code: string; message: string; details?: unknown }; meta: Meta };

export interface MetaSources {
  timezone?: string;
  requests?: RequestStats;
  cache?: CacheStats;
  usedApi: boolean;
}

export class Output {
  readonly warnings: string[] = [];
  coverage: Coverage = "complete";
  dryRun = false;

  constructor(
    readonly json: boolean,
    private readonly stdout: (text: string) => void = (t) => process.stdout.write(t),
    private readonly stderr: (text: string) => void = (t) => process.stderr.write(t),
  ) {}

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Lowers coverage; it never goes back up within one command. */
  setCoverage(coverage: Coverage): void {
    const rank = { complete: 0, unknown: 1, partial: 2 } as const;
    if (rank[coverage] > rank[this.coverage]) this.coverage = coverage;
  }

  diagnostic(message: string): void {
    this.stderr(`ticktick: ${message}\n`);
  }

  private meta(sources: MetaSources): Meta {
    return {
      source: sources.usedApi ? "official-open-api" : "local",
      coverage: this.coverage,
      ...(sources.timezone ? { timezone: sources.timezone } : {}),
      fetchedAt: new Date().toISOString(),
      warnings: this.warnings,
      ...(sources.requests ? { requests: sources.requests } : {}),
      ...(sources.cache ? { cache: sources.cache } : {}),
      ...(this.dryRun ? { dryRun: true } : {}),
    };
  }

  success<T>(data: T, human: (data: T) => string, sources: MetaSources): void {
    if (this.json) {
      const envelope: Envelope<T> = { ok: true, data, meta: this.meta(sources) };
      this.stdout(JSON.stringify(envelope, null, 2) + "\n");
      return;
    }
    const text = human(data);
    if (text) this.stdout(text.endsWith("\n") ? text : text + "\n");
    this.flushWarnings();
  }

  failure(error: CliError, sources: MetaSources): void {
    if (this.json) {
      const envelope: Envelope<never> = {
        ok: false,
        error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) },
        meta: this.meta(sources),
      };
      this.stdout(JSON.stringify(envelope, null, 2) + "\n");
      return;
    }
    this.stderr(`error [${error.code}]: ${error.message}\n`);
    this.flushWarnings();
  }

  private flushWarnings(): void {
    for (const w of this.warnings) this.stderr(`warning: ${w}\n`);
  }
}

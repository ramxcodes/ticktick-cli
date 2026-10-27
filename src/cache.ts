import { readSecureJson, writeSecureJson } from "./config";

/**
 * Opt-in short-lived cache for GET responses (`--cache-ttl <seconds>` on read commands).
 * Mutating commands never read from it and clear it after any write, so a cached
 * snapshot can never be the basis of a write decision.
 */

const FILE = "cache.json";

interface Entry {
  at: number;
  body: unknown;
}

export interface CacheStats {
  ttlSeconds: number;
  hits: number;
  misses: number;
  /** Age of the oldest cached response used in this command, in seconds. */
  oldestHitAgeSeconds?: number;
}

export class ReadCache {
  readonly stats: CacheStats;
  private entries: Record<string, Entry> = {};
  private loaded = false;
  private dirty = false;

  constructor(private readonly ttlSeconds: number, private readonly now: () => number = Date.now) {
    this.stats = { ttlSeconds, hits: 0, misses: 0 };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.entries = (await readSecureJson<Record<string, Entry>>(FILE)) ?? {};
  }

  async get(key: string): Promise<unknown | undefined> {
    await this.load();
    const entry = this.entries[key];
    const age = entry ? this.now() - entry.at : Infinity;
    if (!entry || age > this.ttlSeconds * 1000) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    const ageSeconds = Math.round(age / 1000);
    this.stats.oldestHitAgeSeconds = Math.max(this.stats.oldestHitAgeSeconds ?? 0, ageSeconds);
    return entry.body;
  }

  async set(key: string, body: unknown): Promise<void> {
    await this.load();
    this.entries[key] = { at: this.now(), body };
    this.dirty = true;
  }

  /** Persists new entries, dropping expired ones. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const cutoff = this.now() - this.ttlSeconds * 1000;
    const fresh = Object.fromEntries(Object.entries(this.entries).filter(([, e]) => e.at >= cutoff));
    await writeSecureJson(FILE, fresh);
  }
}

/** Removes every cached response. Called after any successful or uncertain write. */
export async function clearReadCache(): Promise<void> {
  const existing = await readSecureJson<Record<string, Entry>>(FILE);
  if (existing && Object.keys(existing).length > 0) await writeSecureJson(FILE, {});
}

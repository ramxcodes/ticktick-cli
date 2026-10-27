import { createHash } from "crypto";
import { readSecureJson, withLock, writeSecureJson } from "./config";
import { CliError, toCliError } from "./errors";

/**
 * Optional idempotency ledger for automation (`--op-id <id>`), stored in ops.json.
 *
 * The API has no idempotency keys, so exactly-once is impossible. What the ledger
 * guarantees:
 * - The same op id with the same request never writes twice after a confirmed success;
 *   it replays the recorded result (after checking the task still exists).
 * - The same op id with a different request is rejected (OP_ID_CONFLICT).
 * - If a previous attempt's outcome is unknown (timeout, crash), the CLI refuses to
 *   repeat it and returns UNCERTAIN_WRITE until someone reconciles with `ticktick ops resolve`.
 * - Concurrent runs are serialised with a lock file.
 */

const FILE = "ops.json";
const LOCK = "ops";
const RETENTION_MS = 30 * 24 * 3600_000;

export type OpState = "pending" | "succeeded" | "uncertain" | "failed";

export interface OpRecord {
  opId: string;
  command: string;
  fingerprint: string;
  state: OpState;
  taskId?: string;
  projectId?: string;
  etag?: string;
  /** Title of a created task, used to list reconciliation candidates. */
  title?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

type Ledger = Record<string, OpRecord>;

export function fingerprint(command: string, request: unknown): string {
  return createHash("sha256").update(JSON.stringify([command, request])).digest("hex").slice(0, 32);
}

export function validateOpId(opId: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(opId)) {
    throw new CliError("INVALID_ARGUMENT", "--op-id must be 1-128 characters of letters, digits, dot, underscore, colon, or dash.");
  }
  return opId;
}

async function readLedger(): Promise<Ledger> {
  return (await readSecureJson<Ledger>(FILE)) ?? {};
}

async function writeLedger(ledger: Ledger, now: number): Promise<void> {
  const kept = Object.fromEntries(Object.entries(ledger).filter(([, r]) => now - r.updatedAt < RETENTION_MS));
  await writeSecureJson(FILE, kept);
}

export async function listOps(): Promise<OpRecord[]> {
  return Object.values(await readLedger()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findOp(opId: string): Promise<OpRecord | undefined> {
  return (await readLedger())[opId];
}

export async function getOp(opId: string): Promise<OpRecord> {
  const record = await findOp(opId);
  if (!record) throw new CliError("NOT_FOUND", `No recorded operation with id ${opId}.`);
  return record;
}

/** Marks an uncertain operation as resolved, after a human or agent checked TickTick. */
export async function resolveOp(opId: string, outcome: { taskId: string; projectId: string } | "not-applied", now = Date.now()): Promise<OpRecord> {
  return withLock(LOCK, async () => {
    const ledger = await readLedger();
    const record = ledger[opId];
    if (!record) throw new CliError("NOT_FOUND", `No recorded operation with id ${opId}.`);
    if (record.state === "succeeded" || record.state === "failed") {
      throw new CliError("CONFLICT", `Operation ${opId} is already ${record.state}.`);
    }
    const updated: OpRecord =
      outcome === "not-applied"
        ? { ...record, state: "failed", error: "resolved as not applied", updatedAt: now }
        : { ...record, state: "succeeded", taskId: outcome.taskId, projectId: outcome.projectId, updatedAt: now };
    ledger[opId] = updated;
    await writeLedger(ledger, now);
    return updated;
  });
}

export interface OpOutcome<T> {
  result: T;
  record: Partial<Pick<OpRecord, "taskId" | "projectId" | "etag" | "title">>;
}

export type RunResult<T> = { replayed: false; value: T } | { replayed: true; record: OpRecord };

/**
 * Runs `execute` at most once per op id. While the lock is held, no other process can
 * start the same (or any) recorded operation.
 */
export async function runOnce<T>(
  opId: string,
  command: string,
  request: unknown,
  execute: () => Promise<OpOutcome<T>>,
  context: Partial<Pick<OpRecord, "title" | "projectId" | "taskId">> = {},
  now: () => number = Date.now,
): Promise<RunResult<T>> {
  const fp = fingerprint(command, request);
  return withLock(LOCK, async () => {
    const ledger = await readLedger();
    const existing = ledger[opId];
    if (existing && existing.state !== "failed") {
      if (existing.fingerprint !== fp || existing.command !== command) {
        throw new CliError("OP_ID_CONFLICT", `Operation id ${opId} was already used for a different request.`, { previous: existing });
      }
      if (existing.state === "succeeded") return { replayed: true, record: existing };
      throw new CliError(
        "UNCERTAIN_WRITE",
        `A previous attempt of operation ${opId} has an unknown outcome. Check TickTick, then run \`ticktick ops resolve ${opId} --task <id>\` or \`--not-applied\`.`,
        { operation: existing },
      );
    }

    const started = now();
    ledger[opId] = { opId, command, fingerprint: fp, state: "pending", ...context, createdAt: started, updatedAt: started };
    await writeLedger(ledger, started);
    try {
      const { result, record } = await execute();
      ledger[opId] = { ...ledger[opId]!, ...record, state: "succeeded", updatedAt: now() };
      await writeLedger(ledger, now());
      return { replayed: false, value: result };
    } catch (error) {
      const e = toCliError(error);
      // Only a definite rejection frees the op id for another attempt.
      const definite = !["UNCERTAIN_WRITE", "VERIFY_FAILED", "INTERNAL"].includes(e.code);
      ledger[opId] = { ...ledger[opId]!, state: definite ? "failed" : "uncertain", error: `${e.code}: ${e.message}`, updatedAt: now() };
      await writeLedger(ledger, now());
      throw e;
    }
  });
}

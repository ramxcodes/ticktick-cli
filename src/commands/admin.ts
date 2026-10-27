import { lstat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { resolveToken } from "../auth";
import { configDir, configFile, loadConfig, saveConfig, SETTABLE_KEYS, type SettableKey } from "../config";
import { CliError, toCliError, type ErrorCode } from "../errors";
import { getOp, listOps, resolveOp } from "../ops";
import { locateTask } from "../resolve";
import { listProjectsWithInbox, scanOpenTasks } from "../scan";
import type { Runtime } from "../runtime";
import { formatApiDate, isValidTimeZone, machineTimeZone, parseApiDate } from "../time";
import pkg from "../../package.json";

function settable(key: string): SettableKey {
  if (!(SETTABLE_KEYS as readonly string[]).includes(key)) throw new CliError("INVALID_ARGUMENT", `Unknown setting "${key}". Settable: ${SETTABLE_KEYS.join(", ")}.`);
  return key as SettableKey;
}

export async function configShow(rt: Runtime): Promise<void> {
  const config = await loadConfig();
  const data = { configDir: configDir(), timezone: config.timezone ?? null };
  rt.out.success(data, (d) => `config dir: ${d.configDir}\ntimezone: ${d.timezone ?? "(not set)"}`, rt.metaSources());
}

export async function configSet(rt: Runtime, key: string, value: string): Promise<void> {
  const k = settable(key);
  if (k === "timezone" && !isValidTimeZone(value)) throw new CliError("INVALID_ARGUMENT", `Unknown timezone: ${value}.`);
  await saveConfig({ ...(await loadConfig()), [k]: value });
  rt.out.success({ [k]: value }, () => `✓ ${k} = ${value}`, rt.metaSources());
}

export async function configUnset(rt: Runtime, key: string): Promise<void> {
  const k = settable(key);
  const config = await loadConfig();
  delete config[k];
  await saveConfig(config);
  rt.out.success({ [k]: null }, () => `✓ ${k} unset`, rt.metaSources());
}

export async function opsList(rt: Runtime): Promise<void> {
  const ops = await listOps();
  rt.out.success(ops, () => (ops.length ? ops.map((o) => `${o.state.padEnd(9)} ${o.opId}  ${o.command}  ${o.taskId ?? ""}`).join("\n") : "No recorded operations."), rt.metaSources());
}

/**
 * `ops show <id>`: the record plus, for an uncertain create, open tasks with the same
 * title created after the attempt started. Candidates are evidence, not proof.
 */
export async function opsShow(rt: Runtime, opId: string): Promise<void> {
  const record = await getOp(opId);
  let candidates: Array<{ id: string; title: string; projectId: string; createdTime?: string }> | undefined;
  if (record.command === "task.create" && (record.state === "uncertain" || record.state === "pending") && record.title) {
    const api = await rt.api();
    const projects = await listProjectsWithInbox(api);
    const scope = projects.filter((p) => p.id === record.projectId || (p.id === "inbox" && record.projectId?.startsWith("inbox")));
    const scan = await scanOpenTasks(api, { projects: scope.length ? scope : projects, includeClosed: true });
    // Allow for clock skew between this machine and TickTick.
    const since = record.createdAt - 60_000;
    candidates = scan.tasks
      .filter((t) => t.title === record.title && (parseApiDate(t.createdTime) ?? since) >= since)
      .map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, ...(t.createdTime ? { createdTime: t.createdTime } : {}) }));
  }
  rt.out.success({ operation: record, ...(candidates ? { candidates } : {}) }, (d) => JSON.stringify(d, null, 2), rt.metaSources());
}

export async function opsResolve(rt: Runtime, opId: string, opts: { task?: string; notApplied?: boolean }): Promise<void> {
  if (Boolean(opts.task) === Boolean(opts.notApplied)) throw new CliError("INVALID_ARGUMENT", "Pass exactly one of --task <id> or --not-applied.");
  let outcome: { taskId: string; projectId: string } | "not-applied" = "not-applied";
  if (opts.task) {
    const located = await locateTask(await rt.api(), opts.task);
    outcome = { taskId: located.task.id, projectId: located.task.projectId };
  }
  const record = await resolveOp(opId, outcome);
  rt.out.success(record, (r) => `✓ ${r.opId} is now ${r.state}`, rt.metaSources());
}

type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string; code?: ErrorCode };

/** `doctor`: configuration, credentials, connectivity, and capability checks. Never prints secrets. */
export async function doctor(rt: Runtime): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string, code?: ErrorCode) => checks.push({ name, status, detail, ...(code ? { code } : {}) });
  const fail = (name: string, error: unknown) => {
    const e = toCliError(error);
    add(name, "fail", `${e.code}: ${e.message}`, e.code);
  };
  add("version", "ok", `ticktick-cli ${pkg.version}, Bun ${Bun.version}, ${process.platform}`);

  try {
    await loadConfig();
    add("config", "ok", `${configFile()} (directory 700, file 600 enforced)`);
  } catch (error) {
    fail("config", error);
  }
  const legacy = join(homedir(), ".hermes", "credentials", "ticktick-cli");
  if (legacy !== configDir() && (await lstat(legacy).then(() => true, () => false))) {
    add("legacy-config", "warn", `v1 credentials found at ${legacy}. See MIGRATION.md; set TICKTICK_CONFIG_DIR or log in again.`);
  }

  let authed = false;
  try {
    const t = await resolveToken(rt.now);
    const days = t.expiresAt ? Math.floor((t.expiresAt - rt.now) / 86_400_000) : undefined;
    add("credentials", days !== undefined && days < 7 ? "warn" : "ok", `source: ${t.source}${days !== undefined ? `, expires in ${days} day(s)` : ""}`);
    authed = true;
  } catch (error) {
    fail("credentials", error);
  }

  if (authed) {
    const api = await rt.api();
    const started = performance.now();
    try {
      const projects = await api.listProjects();
      add("api", "ok", `GET /project in ${Math.round(performance.now() - started)} ms (${projects.length} projects)`);
      const day = { startDate: formatApiDate(rt.now - 86_400_000), endDate: formatApiDate(rt.now) };
      await api.completedTasks(day);
      add("capability:completed-history", "ok", "POST /task/completed reachable (200-row cap handled by paging)");
      await api.filterTasks({ status: [-1] });
      add("capability:abandoned", "ok", "POST /task/filter reachable");
    } catch (error) {
      fail("api", error);
    }
    try {
      const info = await rt.timezoneInfo();
      add("timezone", "ok", `${info.name} (from ${info.source}; machine is ${machineTimeZone()})`);
    } catch (error) {
      fail("timezone", error);
    }
  }

  const failed = checks.filter((c) => c.status === "fail");
  const human = () => checks.map((c) => `${{ ok: "✓", warn: "!", fail: "✗" }[c.status]} ${c.name}: ${c.detail}`).join("\n");
  if (failed.length > 0) {
    if (!rt.out.json) process.stdout.write(human() + "\n");
    throw new CliError(failed[0]!.code ?? "INVALID_CONFIG", `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}.`, { checks });
  }
  rt.out.success({ checks }, human, rt.metaSources());
}

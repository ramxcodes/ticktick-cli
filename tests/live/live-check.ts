#!/usr/bin/env bun
/**
 * Live validation against the real TickTick API. Run with: TICKTICK_LIVE=1 bun run test:live
 *
 * Writes ONLY inside two disposable projects it creates ("zz-ticktick-cli-live-*") and
 * deletes them at the end, even on failure. Personal tasks are only read.
 * Uses the normal credentials (TICKTICK_TOKEN or the config dir).
 */
import { join } from "path";
import { TickTickApi } from "../../src/api";
import { API_HOST, resolveToken } from "../../src/auth";
import { ApiClient } from "../../src/http";

if (process.env.TICKTICK_LIVE !== "1") {
  console.error("Refusing to run: set TICKTICK_LIVE=1 to confirm live API access.");
  process.exit(2);
}

const CLI = join(import.meta.dir, "../../src/cli.ts");
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function cli(...args: string[]): Promise<{ code: number; json: any }> {
  const proc = Bun.spawn(["bun", CLI, ...args, "--json"], { stdout: "pipe", stderr: "inherit", env: process.env });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, json: JSON.parse(out) };
}

function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, ...(ok ? {} : { detail: JSON.stringify(detail).slice(0, 400) }) });
  console.error(`${ok ? "✓" : "✗"} ${name}`);
}

const { token } = await resolveToken();
const api = new TickTickApi(new ApiClient({ baseUrl: `${API_HOST()}/open/v1`, getToken: async () => token }));
const stamp = Date.now();
const created: string[] = [];

try {
  const p1 = await cli("projects", "create", `zz-ticktick-cli-live-${stamp}`);
  const p2 = await cli("projects", "create", `zz-ticktick-cli-live-b-${stamp}`);
  check("create disposable projects", p1.json.ok && p2.json.ok, [p1.json, p2.json]);
  const P = p1.json.data.id as string;
  const P2 = p2.json.data.id as string;
  created.push(P, P2);

  const meeting = await cli("task", "create", "Live meeting", "-p", P, "--start", "tomorrow 12:00", "--due", "tomorrow 12:15", "--repeat", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "--reminder", "15m", "--tag", "zzlive", "--priority", "high", "--content", "agenda");
  check("create recurring interval with reminder/tag/priority", meeting.json.ok && meeting.json.data.task.schedule.kind === "interval", meeting.json);
  const M = meeting.json.data.task.id as string;

  const update = await cli("task", "update", M, "-p", P, "--title", "Live meeting (renamed)");
  const t = update.json.data?.task;
  check("partial update keeps reminders, tags, repeat, dates, priority", update.json.ok && t.reminders?.length === 1 && t.tags?.[0] === "zzlive" && t.repeatFlag?.includes("BYDAY") && t.priority === 5 && t.content === "agenda" && t.startDate === meeting.json.data.task.startDate, update.json);

  const allDay = await cli("task", "create", "Live trip", "-p", P, "--start", "2026-12-01", "--due", "2026-12-02");
  check("all-day two-day task round-trips", allDay.json.data?.task?.schedule?.startDay === "2026-12-01" && allDay.json.data.task.schedule.endDay === "2026-12-02", allDay.json);

  const list = await cli("task", "create", "Live checklist", "-p", P, "--item", "one", "--item", "two");
  const L = list.json.data.task.id as string;
  const add = await cli("checklist", "add", L, "three", "-p", P);
  check("checklist add gets a server id and keeps items", add.json.ok && add.json.data.items.length === 3 && /^[a-f0-9]{24}$/.test(add.json.data.item.id), add.json);
  const done = await cli("checklist", "complete", L, "one", "-p", P);
  check("checklist complete stores status 1", done.json.data?.item?.status === 1, done.json);
  const del = await cli("checklist", "delete", L, "two", "-p", P);
  check("checklist delete removes only that item", del.json.ok && del.json.data.items.map((i: { title: string }) => i.title).join() === "one,three", del.json);

  const child = await cli("task", "create", "Live child", "--parent", L);
  const subs = await cli("task", "subtasks", L, "-p", P);
  check("subtask create and list", child.json.ok && subs.json.data?.[0]?.id === child.json.data.task.id, [child.json, subs.json]);

  const occ = await cli("task", "complete", M, "-p", P);
  check("complete recurring = one occurrence, series advances", occ.json.data?.outcome === "occurrence_completed", occ.json);

  const single = await cli("task", "create", "Live single", "-p", P, "--due", "today 23:00");
  const S = single.json.data.task.id as string;
  const comp = await cli("task", "complete", S, "-p", P);
  const got = await cli("task", "get", S, "-p", P);
  check("complete non-recurring, then state=completed", comp.json.data?.outcome === "completed" && got.json.data?.state === "completed", [comp.json, got.json]);

  const hist = await cli("tasks", "completed", "-p", P, "--days", "2", "--from", "yesterday");
  check("completed history includes both completions", hist.json.ok && hist.json.data.length >= 2 && hist.json.meta.coverage === "complete", hist.json);

  const ab = await cli("task", "create", "Live abandon", "-p", P);
  const abd = await cli("task", "abandon", ab.json.data.task.id, "-p", P);
  const abl = await cli("tasks", "abandoned", "-p", P);
  check("abandon and list abandoned", abd.json.data?.task?.status === -1 && abl.json.data.some((x: { id: string }) => x.id === ab.json.data.task.id), [abd.json, abl.json]);

  const mv = await cli("task", "move", allDay.json.data.task.id, "-p", P, "--to", P2);
  check("move verified by read-back", mv.json.data?.task?.projectId === P2, mv.json);

  const b1 = await cli("task", "create", "Live batch 1", "-p", P2);
  const b2 = await cli("task", "create", "Live batch 2", "-p", P2);
  const batch = await cli("tasks", "complete", b1.json.data.task.id, b2.json.data.task.id, "ffffffffffffffffffffffff");
  check("batch complete reports per-task results incl. failure", batch.code === 8 && batch.json.error.details.results.filter((r: { ok: boolean }) => r.ok).length === 2, batch.json);

  const op1 = await cli("task", "create", "Live idempotent", "-p", P, "--op-id", `live-${stamp}`);
  const op2 = await cli("task", "create", "Live idempotent", "-p", P, "--op-id", `live-${stamp}`);
  check("op-id create replays without a second task", op2.json.data?.replayed === true && op2.json.data.task.id === op1.json.data.task.id, [op1.json, op2.json]);

  const dry = await cli("task", "update", M, "-p", P, "--title", "should not apply", "--dry-run");
  const after = await cli("task", "get", M, "-p", P);
  check("dry-run writes nothing", dry.json.meta.requests.writes === 0 && after.json.data.title === "Live meeting (renamed)", [dry.json.meta, after.json.data?.title]);

  const gone = await cli("task", "delete", S, "--yes");
  const dget = await cli("task", "get", op1.json.data.task.id, "-p", P);
  const d2 = await cli("task", "delete", op1.json.data.task.id, "--yes");
  const d2get = await cli("task", "get", op1.json.data.task.id, "-p", P);
  check("delete open task verified; deleted task reports deleted_or_unknown", gone.json.ok && dget.json.data?.state === "open" && d2.json.data?.verified === true && d2get.json.data?.state === "deleted_or_unknown", [gone.json, d2.json, d2get.json]);

  const agenda = await cli("agenda", "-p", P, "--from", "today", "--days", "8");
  const sources = new Set(agenda.json.data?.entries?.map((e: { occurrence?: { source: string } }) => e.occurrence?.source));
  check("agenda marks server and calculated occurrences", sources.has("server") && sources.has("calculated"), agenda.json.data?.entries);
} catch (error) {
  check("unexpected error", false, String(error));
} finally {
  for (const id of created) {
    try {
      await api.deleteProject(id);
      console.error(`cleanup: deleted project ${id}`);
    } catch (error) {
      console.error(`cleanup FAILED for project ${id}: ${error}`);
      results.push({ name: `cleanup ${id}`, ok: false });
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed }, null, 2));
process.exit(failed.length ? 1 : 0);

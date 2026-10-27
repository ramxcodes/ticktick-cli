import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FakeTickTick, task } from "./fake-server";

/**
 * End-to-end: the real CLI process against a fake TickTick server.
 * Checks the JSON envelope, exit codes, and exactly which writes reach the API.
 */

const fake = new FakeTickTick().start();
const dirs: string[] = [];
afterAll(async () => {
  fake.stop();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const ID = {
  work: "a00000000000000000000001",
  home: "a00000000000000000000002",
  report: "b00000000000000000000001",
  dupe1: "b00000000000000000000002",
  dupe2: "b00000000000000000000003",
  meeting: "b00000000000000000000004",
  checklist: "b00000000000000000000005",
  missing: "ffffffffffffffffffffffff",
};
const at = (local: string) => new Date(Date.parse(`${local}:00+05:30`)).toISOString().replace("Z", "+0000");

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "tt-cli-"));
  dirs.push(configDir);
  fake.faults = [];
  fake.log = [];
  fake.projects = [
    { id: ID.work, name: "Work" },
    { id: ID.home, name: "Home" },
  ];
  fake.tasks = [
    task({ id: ID.report, projectId: ID.work, title: "Write report", tags: ["deep"], reminders: ["TRIGGER:PT0S"], dueDate: at("2026-10-28T17:00"), timeZone: "Asia/Kolkata" }),
    task({ id: ID.dupe1, projectId: ID.work, title: "Call bank" }),
    task({ id: ID.dupe2, projectId: ID.home, title: "Call bank" }),
    task({ id: ID.meeting, projectId: ID.work, title: "Standup", startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:15"), repeatFlag: "RRULE:FREQ=DAILY", timeZone: "Asia/Kolkata" }),
    task({ id: ID.checklist, projectId: ID.home, title: "Groceries", items: [{ id: "c00000000000000000000001", title: "Milk", status: 0 }] }),
    task({ id: "d00000000000000000000001", projectId: ID.work, title: "Old done", status: 2, completedTime: at("2026-10-27T09:00") }),
  ];
});

interface Result {
  code: number;
  json: { ok: boolean; data?: any; error?: { code: string; message: string; details?: any }; meta: any };
  stderr: string;
  stdout: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Result> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
    env: {
      PATH: process.env.PATH!,
      HOME: configDir,
      TICKTICK_TOKEN: "test-token",
      TICKTICK_API_BASE: fake.url,
      TICKTICK_CONFIG_DIR: join(configDir, "cfg"),
      TICKTICK_TIMEOUT_MS: "500",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: Result["json"];
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not one JSON document (exit ${code}):\n${stdout}\n--- stderr ---\n${stderr}`);
  }
  expect(stdout + stderr).not.toContain("test-token");
  return { code, json, stderr, stdout };
}

describe("reads", () => {
  test("tasks list: envelope, coverage, timezone, full ids", async () => {
    const r = await cli(["tasks", "list"]);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.meta).toMatchObject({ source: "official-open-api", coverage: "complete", timezone: "Asia/Kolkata", warnings: [] });
    expect(r.json.data.map((t: { id: string }) => t.id)).toContain(ID.report);
    expect(r.json.data.find((t: { id: string }) => t.id === ID.meeting).schedule).toEqual({ kind: "interval", start: "2026-10-28T12:00:00+05:30", end: "2026-10-28T12:15:00+05:30" });
  });
  test("a failed project read fails the command unless --allow-partial", async () => {
    fake.faults = [{ match: new RegExp(`GET /project/${ID.home}/data`), status: 403, times: 10 }];
    const r = await cli(["tasks", "list"]);
    expect(r.code).toBe(6);
    expect(r.json.error).toMatchObject({ code: "PARTIAL_DATA" });
    expect(r.json.error!.details.failures[0]).toMatchObject({ projectId: ID.home, code: "PERMISSION_DENIED" });

    fake.faults = [{ match: new RegExp(`GET /project/${ID.home}/data`), status: 403, times: 10 }];
    const p = await cli(["tasks", "list", "--allow-partial"]);
    expect(p.code).toBe(0);
    expect(p.json.meta.coverage).toBe("partial");
    expect(p.json.meta.warnings[0]).toContain("Home");
  });
  test("tasks completed uses completion history", async () => {
    const r = await cli(["tasks", "completed", "--from", "2026-10-20", "--to", "2026-10-27"]);
    expect(r.json.data.map((t: { id: string }) => t.id)).toEqual(["d00000000000000000000001"]);
    expect(r.json.data[0].state).toBe("completed");
  });
  test("--fields is validated", async () => {
    const r = await cli(["tasks", "list", "--fields", "id,bogus"]);
    expect(r.code).toBe(2);
    expect(r.json.error!.code).toBe("INVALID_ARGUMENT");
    expect(fake.log).toHaveLength(0);
  });
  test("agenda separates the meeting from the deadline", async () => {
    const r = await cli(["agenda", "--date", "2026-10-28"]);
    const kinds = r.json.data.entries.map((e: { title: string; kind: string; blocksTime: boolean }) => [e.title, e.kind, e.blocksTime]);
    expect(kinds).toEqual([["Standup", "interval", true], ["Write report", "deadline", false]]);
    expect(r.json.data.busy).toEqual([{ start: "2026-10-28T12:00:00+05:30", end: "2026-10-28T12:15:00+05:30" }]);
  });
  test("--overdue lists only tasks whose due moment has passed", async () => {
    fake.tasks.push(
      task({ id: "e00000000000000000000001", projectId: ID.work, title: "Late", dueDate: at("2020-01-01T09:00") }),
      task({ id: "e00000000000000000000002", projectId: ID.work, title: "Future", dueDate: at("2099-01-01T09:00") }),
      task({ id: "e00000000000000000000003", projectId: ID.work, title: "Old trip", isAllDay: true, startDate: at("2020-02-01T00:00"), dueDate: at("2020-02-01T00:00") }),
    );
    const r = await cli(["tasks", "list", "--overdue"]);
    const titles = r.json.data.map((t: { title: string }) => t.title);
    expect(titles).toContain("Late");
    expect(titles).toContain("Old trip");
    expect(titles).not.toContain("Future");
  });
  test("rate limiting is retried and counted", async () => {
    fake.faults = [{ match: /GET \/project$/, status: 429, headers: { "Retry-After": "0" } }];
    const r = await cli(["projects", "list"]);
    expect(r.code).toBe(0);
    expect(r.json.meta.requests.retries).toBe(1);
  });
});

describe("resolution and lifecycle state", () => {
  test("an ambiguous title is rejected with candidates and no write", async () => {
    const r = await cli(["task", "complete", "call bank"]);
    expect(r.code).toBe(5);
    expect(r.json.error!.code).toBe("AMBIGUOUS");
    expect(r.json.error!.details.candidates).toHaveLength(2);
    expect(fake.writes()).toEqual([]);
  });
  test("a missing id is NOT_FOUND, never 'completed'", async () => {
    const r = await cli(["task", "get", ID.missing]);
    expect(r.code).toBe(4);
    expect(r.json.error!.code).toBe("NOT_FOUND");
  });
  test("a completed task reports state completed and cannot be changed", async () => {
    const get = await cli(["task", "get", "d00000000000000000000001"]);
    expect(get.json.data.state).toBe("completed");
    const upd = await cli(["task", "update", "d00000000000000000000001", "--title", "x"]);
    expect(upd.code).toBe(4);
    expect(upd.json.error).toMatchObject({ code: "TASK_NOT_OPEN", details: { state: "completed" } });
  });
});

describe("writes", () => {
  test("dry-run sends no write", async () => {
    const r = await cli(["task", "create", "Plan", "--project", "Work", "--due", "2026-10-29T10:00", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.json.meta.dryRun).toBe(true);
    expect(r.json.data.requests[0]).toMatchObject({ method: "POST", path: "/task", body: { title: "Plan", projectId: ID.work, dueDate: "2026-10-29T04:30:00.000+0000", isAllDay: false, timeZone: "Asia/Kolkata" } });
    expect(fake.writes()).toEqual([]);
  });
  test("a create that lands in another project is VERIFY_FAILED", async () => {
    fake.faults = [{ match: /POST \/task$/, status: 200, body: JSON.stringify({ id: "f00000000000000000000001", projectId: ID.home, title: "Plan", status: 0 }) }];
    const r = await cli(["task", "create", "Plan", "--project", "Work"]);
    expect(r.json.error).toMatchObject({ code: "VERIFY_FAILED", details: { mismatches: [{ field: "projectId" }] } });
  });
  test("date-only input creates an all-day task with an exclusive end", async () => {
    const r = await cli(["task", "create", "Trip", "--project", "Home", "--start", "2026-11-04", "--due", "2026-11-05"]);
    expect(r.json.data.task).toMatchObject({ isAllDay: true, schedule: { kind: "all-day", startDay: "2026-11-04", endDay: "2026-11-05" } });
    expect(r.json.data.task.dueDate).toBe("2026-11-05T18:30:00.000+0000");
  });
  test("--op-id makes create idempotent", async () => {
    const first = await cli(["task", "create", "Plan", "--project", "Work", "--op-id", "plan-1"]);
    const second = await cli(["task", "create", "Plan", "--project", "Work", "--op-id", "plan-1"]);
    expect(first.json.data.replayed).toBe(false);
    expect(second.json.data).toMatchObject({ replayed: true, task: { id: first.json.data.task.id } });
    expect(fake.writes().filter((w) => w.path === "/task")).toHaveLength(1);
    const other = await cli(["task", "create", "Different", "--project", "Work", "--op-id", "plan-1"]);
    expect(other.json.error!.code).toBe("OP_ID_CONFLICT");
  });
  test("a lost create response is UNCERTAIN_WRITE, never retried, and reconcilable", async () => {
    fake.faults = [{ match: /POST \/task$/, status: 504, afterApply: true }];
    const first = await cli(["task", "create", "Pay rent", "--project", "Home", "--op-id", "rent-oct"]);
    expect(first.code).toBe(8);
    expect(first.json.error!.code).toBe("UNCERTAIN_WRITE");
    const again = await cli(["task", "create", "Pay rent", "--project", "Home", "--op-id", "rent-oct"]);
    expect(again.json.error!.code).toBe("UNCERTAIN_WRITE");
    expect(fake.writes().filter((w) => w.path === "/task")).toHaveLength(1);

    const show = await cli(["ops", "show", "rent-oct"]);
    const created = fake.tasks.find((t) => t.title === "Pay rent")!;
    expect(show.json.data.candidates.map((c: { id: string }) => c.id)).toEqual([created.id]);
    await cli(["ops", "resolve", "rent-oct", "--task", created.id]);
    const replay = await cli(["task", "create", "Pay rent", "--project", "Home", "--op-id", "rent-oct"]);
    expect(replay.json.data).toMatchObject({ replayed: true, task: { id: created.id } });
  });
  test("a create that times out is UNCERTAIN_WRITE", async () => {
    fake.faults = [{ match: /POST \/task$/, hang: true }];
    const r = await cli(["task", "create", "Slow", "--project", "Work"]);
    expect(r.json.error!.code).toBe("UNCERTAIN_WRITE");
    expect(fake.writes()).toHaveLength(1);
  });
  test("update sends only changed fields and keeps the rest", async () => {
    const r = await cli(["task", "update", ID.report, "--title", "Write final report", "--add-tag", "q4"]);
    expect(r.code).toBe(0);
    const body = fake.writes()[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["id", "projectId", "tags", "title"]);
    expect(r.json.data.task).toMatchObject({ title: "Write final report", tags: ["deep", "q4"], reminders: ["TRIGGER:PT0S"], dueDate: at("2026-10-28T17:00") });
  });
  test("changing one date keeps the other", async () => {
    const trip = await cli(["task", "create", "Trip", "--project", "Home", "--start", "2026-12-01", "--due", "2026-12-03"]);
    const id = trip.json.data.task.id;
    const r = await cli(["task", "update", id, "--due", "2026-12-05"]);
    expect(r.json.data.task.schedule).toEqual({ kind: "all-day", startDay: "2026-12-01", endDay: "2026-12-05" });
    const meet = await cli(["task", "update", ID.meeting, "--due", "2026-10-28T12:45"]);
    expect(meet.json.data.task.schedule).toEqual({ kind: "interval", start: "2026-10-28T12:00:00+05:30", end: "2026-10-28T12:45:00+05:30" });
    const bad = await cli(["task", "update", ID.meeting, "--due", "2026-10-28T11:00"]);
    expect(bad.json.error!.code).toBe("INVALID_ARGUMENT");
  });
  test("--if-etag detects a concurrent change", async () => {
    const r = await cli(["task", "update", ID.report, "--title", "x", "--if-etag", "stale"]);
    expect(r.code).toBe(9);
    expect(r.json.error!.code).toBe("CONFLICT");
    expect(fake.writes()).toEqual([]);
  });
  test("completing a recurring task completes one occurrence", async () => {
    const r = await cli(["task", "complete", ID.meeting]);
    expect(r.json.data.outcome).toBe("occurrence_completed");
    expect(r.json.data.task.schedule.start).toBe("2026-10-29T12:00:00+05:30");
  });
  test("complete with --op-id never completes twice", async () => {
    const a = await cli(["task", "complete", ID.meeting, "--op-id", "standup-28"]);
    const b = await cli(["task", "complete", ID.meeting, "--op-id", "standup-28"]);
    expect(a.json.data.outcome).toBe("occurrence_completed");
    expect(b.json.data.replayed).toBe(true);
    expect(fake.writes()).toHaveLength(1);
  });
  test("delete needs --yes and an id; afterwards the task is not open", async () => {
    expect((await cli(["task", "delete", "Write report"])).json.error!.code).toBe("INVALID_ARGUMENT");
    const noConfirm = await cli(["task", "delete", ID.report]);
    expect(noConfirm.code).toBe(11);
    expect(fake.writes()).toEqual([]);
    const done = await cli(["task", "delete", ID.report, "--yes"]);
    expect(done.json.data).toMatchObject({ deleted: true, verified: true });
    const get = await cli(["task", "get", ID.report]);
    expect(get.json.data.state).toBe("deleted_or_unknown");
    const complete = await cli(["task", "complete", ID.report]);
    expect(complete.json.error!.code).toBe("TASK_NOT_OPEN");
  });
  test("a move the server only pretends to do is caught", async () => {
    fake.faults = [{ match: /POST \/task\/move/, status: 200, body: "[]" }];
    const r = await cli(["task", "move", ID.report, "--to", "Home"]);
    expect(r.json.error!.code).toBe("VERIFY_FAILED");
    const ok = await cli(["task", "move", ID.report, "--to", "Home"]);
    expect(ok.json.data.task.projectId).toBe(ID.home);
  });
  test("batch abandon reports each task and fails on partial success", async () => {
    const r = await cli(["tasks", "abandon", ID.dupe1, ID.missing]);
    expect(r.code).toBe(8);
    expect(r.json.error!.code).toBe("BATCH_PARTIAL_FAILURE");
    expect(r.json.error!.details.results).toEqual([
      { taskId: ID.dupe1, ok: true, outcome: "abandoned" },
      expect.objectContaining({ taskId: ID.missing, ok: false, code: "TASK_NOT_OPEN" }),
    ]);
    expect(fake.writes().map((w) => w.path)).toEqual(["/task/batch"]);
  });
  test("batch complete succeeds per task", async () => {
    const r = await cli(["tasks", "complete", ID.dupe1, ID.dupe2]);
    expect(r.code).toBe(0);
    expect(r.json.data.results.map((x: { outcome: string }) => x.outcome)).toEqual(["completed", "completed"]);
  });
  test("checklist add and complete keep other items and use status 1", async () => {
    const add = await cli(["checklist", "add", "Groceries", "Eggs"]);
    expect(add.json.data.items.map((i: { title: string }) => i.title)).toEqual(["Milk", "Eggs"]);
    const done = await cli(["checklist", "complete", "Groceries", "milk"]);
    expect(done.json.data.item).toMatchObject({ title: "Milk", status: 1 });
  });
});

describe("errors and auth", () => {
  test("no credentials is AUTH_REQUIRED (exit 3)", async () => {
    const r = await cli(["tasks", "list"], { TICKTICK_TOKEN: "" });
    expect(r.code).toBe(3);
    expect(r.json.error!.code).toBe("AUTH_REQUIRED");
  });
  test("a rejected token is AUTH_INVALID", async () => {
    const r = await cli(["projects", "list"], { TICKTICK_TOKEN: "wrong" });
    expect(r.json.error!.code).toBe("AUTH_INVALID");
  });
  test("unknown options and bad dates are INVALID_ARGUMENT (exit 2) with JSON", async () => {
    const a = await cli(["tasks", "list", "--nope"]);
    expect([a.code, a.json.error!.code]).toEqual([2, "INVALID_ARGUMENT"]);
    const b = await cli(["task", "create", "x", "--project", "Work", "--due", "2026-02-30"]);
    expect([b.code, b.json.error!.code]).toEqual([2, "INVALID_ARGUMENT"]);
  });
});

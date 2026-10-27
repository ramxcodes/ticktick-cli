import { describe, expect, test } from "bun:test";
import { TickTickApi, type CompletedQuery } from "../src/api";
import { ApiClient } from "../src/http";
import { fetchCompleted, scanOpenTasks } from "../src/scan";
import { formatApiDate, parseApiDate } from "../src/time";
import type { Task } from "../src/types";

/** Fake /task/completed with the observed contract: inclusive bounds, newest first, 200 cap. */
class FakeHistory extends TickTickApi {
  calls = 0;
  constructor(readonly rows: Task[]) {
    super(new ApiClient({ baseUrl: "x", getToken: async () => "t" }));
  }
  override async completedTasks(q: CompletedQuery): Promise<Task[]> {
    this.calls++;
    const s = parseApiDate(q.startDate)!;
    const e = parseApiDate(q.endDate)!;
    return this.rows
      .filter((r) => {
        const at = parseApiDate(r.completedTime)!;
        return at >= s && at <= e;
      })
      .sort((a, b) => parseApiDate(b.completedTime)! - parseApiDate(a.completedTime)!)
      .slice(0, 200);
  }
}

const T0 = Date.parse("2026-10-01T00:00:00Z");
const done = (i: number, at: number): Task => ({ id: `c${i}`.padStart(24, "0"), projectId: "p", title: `t${i}`, status: 2, completedTime: formatApiDate(at) });
const range = { start: T0, end: T0 + 30 * 86_400_000 };

describe("fetchCompleted", () => {
  test("pages past the 200-row cap without losing or duplicating rows", async () => {
    const rows = Array.from({ length: 650 }, (_, i) => done(i, T0 + i * 3_600_000));
    const api = new FakeHistory(rows);
    const r = await fetchCompleted(api, range);
    expect(r.tasks).toHaveLength(650);
    expect(new Set(r.tasks.map((t) => t.id)).size).toBe(650);
    expect(r.coverage).toBe("complete");
  });
  test("keeps rows that share a timestamp with the page boundary", async () => {
    // 199 distinct newer rows, then 50 rows in the same second straddling the cut.
    const rows = [
      ...Array.from({ length: 199 }, (_, i) => done(i, T0 + 10 * 86_400_000 + i * 60_000)),
      ...Array.from({ length: 50 }, (_, i) => done(1000 + i, T0 + 5 * 86_400_000 + i)),
    ];
    const r = await fetchCompleted(new FakeHistory(rows), range);
    expect(r.tasks).toHaveLength(249);
    expect(r.coverage).toBe("complete");
  });
  test("reports partial when more than 200 rows share one second", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => done(i, T0 + 86_400_000 + (i % 1000)));
    const r = await fetchCompleted(new FakeHistory(rows), range);
    expect(r.coverage).toBe("partial");
    expect(r.warnings.join(" ")).toContain("within one second");
  });
  test("excludes rows outside the half-open range", async () => {
    const rows = [done(1, range.start - 1), done(2, range.start), done(3, range.end - 1), done(4, range.end)];
    const r = await fetchCompleted(new FakeHistory(rows), range);
    expect(r.tasks.map((t) => t.id).sort()).toEqual([done(2, 0).id, done(3, 0).id]);
  });
  test("an empty answer is complete only because the API confirmed it", async () => {
    const api = new FakeHistory([]);
    const r = await fetchCompleted(api, range);
    expect(r).toMatchObject({ tasks: [], coverage: "complete" });
    expect(api.calls).toBe(1);
  });
});

/** Real TickTickApi over a fake fetch: per project, a task list, an HTTP error status, or the {} answer. */
function fakeData(data: Record<string, Task[] | number | "missing">): TickTickApi {
  const fakeFetch = (async (url: string | URL | Request) => {
    const path = String(url).replace("https://x", "");
    if (path.startsWith("/project?")) return Response.json(Object.keys(data).filter((id) => id !== "inbox").map((id) => ({ id, name: `P-${id}` })));
    const id = /^\/project\/([^/]+)\/data$/.exec(path)?.[1] ?? "";
    const v = data[id];
    if (typeof v === "number") return new Response("", { status: v });
    return Response.json(v === "missing" || v === undefined ? {} : { tasks: v });
  }) as typeof fetch;
  return new TickTickApi(new ApiClient({ baseUrl: "https://x", getToken: async () => "t", fetch: fakeFetch, maxRetries: 0 }));
}

describe("scanOpenTasks", () => {
  const open = (id: string, projectId: string): Task => ({ id, projectId, title: id, status: 0 });
  test("a failed project fails the scan instead of being skipped", async () => {
    const api = fakeData({ a: [open("1", "a")], b: 403, inbox: [] });
    await expect(scanOpenTasks(api)).rejects.toMatchObject({ code: "PARTIAL_DATA" });
  });
  test("allowPartial returns the data with coverage partial and the failures", async () => {
    const api = fakeData({ a: [open("1", "a")], b: 403, inbox: [] });
    const r = await scanOpenTasks(api, { allowPartial: true });
    expect(r.coverage).toBe("partial");
    expect(r.failures.map((f) => f.projectId)).toEqual(["b"]);
    expect(r.tasks.map((t) => t.id)).toEqual(["1"]);
  });
  test("an unknown project ({} response) is a failure, an empty project is not", async () => {
    const r = await scanOpenTasks(fakeData({ a: [], b: "missing", inbox: [] }), { allowPartial: true });
    expect(r.failures).toMatchObject([{ projectId: "b", code: "NOT_FOUND" }]);
  });
  test("learns the real Inbox id from Inbox tasks", async () => {
    const r = await scanOpenTasks(fakeData({ a: [], inbox: [open("9", "inbox42")] }));
    expect(r.inboxId).toBe("inbox42");
    expect(r.tasks[0]).toMatchObject({ projectId: "inbox42", projectName: "Inbox" });
  });
});

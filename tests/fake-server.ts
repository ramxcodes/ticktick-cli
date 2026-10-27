import type { Project, Task } from "../src/types";

/**
 * Minimal stateful emulation of the TickTick Open API endpoints the CLI uses, with the
 * quirks observed live: /data lists undone tasks only and answers {} for unknown
 * projects, deleted tasks stay readable with status 0, /task/move answers 200 for
 * unknown tasks, and /task/completed and /task/filter cap at 200 rows.
 */

export interface FakeTask extends Task {
  deleted?: boolean;
}

export interface Fault {
  /** Matched against "METHOD /path" (path without query). */
  match: RegExp;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Never answer (forces a client timeout). */
  hang?: boolean;
  /** Apply the request first, then fail (simulates a lost response). */
  afterApply?: boolean;
  times?: number;
}

export class FakeTickTick {
  projects: Project[] = [];
  tasks: FakeTask[] = [];
  inboxId = "inbox1";
  timeZone = "Asia/Kolkata";
  faults: Fault[] = [];
  log: Array<{ method: string; path: string; body: unknown }> = [];
  private server?: ReturnType<typeof Bun.serve>;
  private seq = 0;

  get url(): string {
    return `http://127.0.0.1:${this.server!.port}/open/v1`;
  }

  writes() {
    return this.log.filter((r) => r.method !== "GET" && !["/task/completed", "/task/filter", "/preference"].includes(r.path));
  }

  newId(): string {
    this.seq++;
    return (Date.now().toString(16) + this.seq.toString(16)).padStart(24, "a").slice(-24);
  }

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private notFound(what: string): Response {
    return this.json({ errorId: "x", errorCode: "resource_not_found", errorMessage: `${what} not found`, data: null }, 404);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/open\/v1/, "");
    const text = await req.text();
    const body = text ? JSON.parse(text) : undefined;
    this.log.push({ method: req.method, path, body });
    if (req.headers.get("authorization") !== "Bearer test-token") return new Response("", { status: 401 });

    const fault = this.faults.find((f) => f.match.test(`${req.method} ${path}`) && (f.times ?? 1) > 0);
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.hang) return new Promise(() => {});
      if (fault.afterApply) this.route(req.method, path, body);
      return new Response(fault.body ?? "", { status: fault.status ?? 500, headers: fault.headers ?? {} });
    }
    return this.route(req.method, path, body);
  }

  private live = (id: string) => this.tasks.find((t) => t.id === id);

  private route(method: string, path: string, body: any): Response {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/project") return this.json(this.projects);
    if (method === "POST" && path === "/preference") return this.json({ timeZone: this.timeZone });
    if (method === "GET" && (m = path.match(/^\/project\/([^/]+)\/data$/))) {
      const id = m[1] === "inbox" ? this.inboxId : m[1]!;
      if (id !== this.inboxId && !this.projects.some((p) => p.id === id)) return this.json({});
      const tasks = this.tasks.filter((t) => t.projectId === id && t.status === 0 && !t.deleted).map(({ deleted, ...t }) => t);
      return this.json(m[1] === "inbox" ? { tasks, columns: [] } : { project: this.projects.find((p) => p.id === id), tasks, columns: [] });
    }
    if (method === "GET" && (m = path.match(/^\/project\/([^/]+)\/task\/([^/]+)$/))) {
      const t = this.live(m[2]!);
      if (!t || t.projectId !== m[1]) return this.notFound("task");
      const { deleted, ...rest } = t;
      return this.json(rest);
    }
    if (method === "POST" && path === "/task") {
      const task: FakeTask = { status: 0, priority: 0, ...body, id: this.newId(), etag: this.newId().slice(0, 8), items: (body.items ?? []).map((i: any) => ({ status: 0, ...i, id: i.id ?? this.newId() })) };
      if (!task.items?.length) delete task.items;
      this.tasks.push(task);
      return this.json(task);
    }
    if (method === "POST" && (m = path.match(/^\/task\/([^/]+)$/)) && m[1] !== "batch" && m[1] !== "move" && m[1] !== "completed" && m[1] !== "filter" && m[1] !== "completeTasks") {
      const t = this.live(m[1]!);
      if (!t) return this.notFound("task");
      this.applyUpdate(t, body);
      const { deleted, ...rest } = t;
      return this.json(rest);
    }
    if (method === "POST" && (m = path.match(/^\/project\/([^/]+)\/task\/([^/]+)\/complete$/))) {
      const t = this.live(m[2]!);
      if (!t) return this.notFound("task");
      this.complete(t);
      return this.json(undefined);
    }
    if (method === "DELETE" && (m = path.match(/^\/project\/([^/]+)\/task\/([^/]+)$/))) {
      const t = this.live(m[2]!);
      if (t) t.deleted = true;
      return this.json(undefined);
    }
    if (method === "POST" && path === "/task/move") {
      return this.json(body.map((op: any) => {
        const t = this.live(op.taskId);
        if (t && t.projectId === op.fromProjectId) t.projectId = op.toProjectId;
        return { id: op.taskId, etag: "moved" };
      }));
    }
    if (method === "POST" && path === "/task/batch") {
      const id2etag: Record<string, string> = {};
      const id2error: Record<string, string> = {};
      for (const u of body.update ?? []) {
        const t = this.live(u.id);
        if (!t) id2error[u.id] = "NOT_EXISTED";
        else {
          this.applyUpdate(t, u);
          id2etag[u.id] = t.etag!;
        }
      }
      return this.json({ status: Object.keys(id2error).length ? "partial" : "success", id2etag, id2error });
    }
    if (method === "POST" && path === "/task/completeTasks") {
      const done: string[] = [];
      for (const id of body.taskIds) {
        const t = this.live(id);
        if (t && t.projectId === (body.projectId || this.inboxId) && t.status === 0) {
          this.complete(t);
          done.push(id);
        }
      }
      return this.json(done);
    }
    if (method === "POST" && path === "/task/completed") {
      const start = body.startDate ? Date.parse(body.startDate.replace(/(\d{2})(\d{2})$/, "$1:$2")) : -Infinity;
      const end = body.endDate ? Date.parse(body.endDate.replace(/(\d{2})(\d{2})$/, "$1:$2")) : Infinity;
      const rows = this.tasks
        .filter((t) => t.status === 2 && !t.deleted && (!body.projectIds || body.projectIds.includes(t.projectId)))
        .filter((t) => {
          const at = Date.parse(t.completedTime!.replace(/(\d{2})(\d{2})$/, "$1:$2"));
          return at >= start && at <= end;
        })
        .sort((a, b) => b.completedTime!.localeCompare(a.completedTime!));
      return this.json(rows.slice(0, 200));
    }
    if (method === "POST" && path === "/task/filter") {
      const rows = this.tasks.filter((t) => !t.deleted && (!body.status || body.status.includes(t.status)) && (!body.projectIds || body.projectIds.includes(t.projectId)));
      return this.json(rows.slice(0, 200));
    }
    if (method === "GET" && (m = path.match(/^\/project\/([^/]+)\/column$/))) return this.json([]);
    if (method === "POST" && path === "/project") {
      const p = { id: this.newId(), kind: "TASK", ...body };
      this.projects.push(p);
      return this.json(p);
    }
    return new Response("unknown route", { status: 404 });
  }

  private applyUpdate(t: FakeTask, body: any): void {
    for (const [k, v] of Object.entries(body)) {
      if (k === "id") continue;
      if (k === "items") {
        (t as any).items = (v as any[]).map((i) => ({ status: 0, ...i, id: i.id ?? this.newId() }));
        if (!(t as any).items.length) delete (t as any).items;
      } else if (v === null || v === "") {
        delete (t as any)[k];
        if (k === "startDate" || k === "dueDate") delete t.repeatFlag;
      } else (t as any)[k] = v;
    }
    t.etag = this.newId().slice(0, 8);
  }

  /** Completing a recurring task advances the series and leaves a completed copy. */
  private complete(t: FakeTask): void {
    const now = new Date().toISOString().replace("Z", "+0000");
    if (t.repeatFlag) {
      this.tasks.push({ ...t, id: this.newId(), status: 2, completedTime: now, repeatFlag: undefined });
      const shift = (d?: string) => (d ? new Date(Date.parse(d.replace(/(\d{2})(\d{2})$/, "$1:$2")) + 86_400_000).toISOString().replace("Z", "+0000") : d);
      t.startDate = shift(t.startDate);
      t.dueDate = shift(t.dueDate);
    } else {
      t.status = 2;
      t.completedTime = now;
    }
    t.etag = this.newId().slice(0, 8);
  }
}

export function task(partial: Partial<FakeTask> & { id: string; projectId: string; title: string }): FakeTask {
  return { status: 0, priority: 0, etag: "e0", ...partial };
}

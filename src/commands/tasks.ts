import { BATCH_LIMIT, INBOX_ALIAS } from "../api";
import { classify, type ScheduleKind } from "../agenda";
import { CliError, toCliError } from "../errors";
import { isObjectId, resolveProject } from "../resolve";
import type { Runtime } from "../runtime";
import { fetchAbandoned, fetchCompleted, listProjectsWithInbox, scanOpenTasks } from "../scan";
import { parseApiDate, parseRange } from "../time";
import type { Project, Task } from "../types";
import { parseFields, parseLimit, parsePriority, pickFields, taskLine, toTaskView, type TaskView } from "./shared";

const SCHEDULE_KINDS: ScheduleKind[] = ["interval", "point", "deadline", "all-day", "unscheduled", "invalid"];
const SORT_FIELDS = ["project", "title", "priority", "start", "due", "created", "modified", "completed"] as const;
type SortField = (typeof SORT_FIELDS)[number];

export interface ListOptions {
  project?: string;
  priority?: string;
  tag?: string[];
  search?: string;
  from?: string;
  to?: string;
  date?: string;
  kind?: string;
  sort?: string;
  limit?: string;
  fields?: string;
  includeClosed?: boolean;
  allowPartial?: boolean;
}

function parseSort(value: string | undefined, fallback: SortField): { field: SortField; desc: boolean } {
  if (!value) return { field: fallback, desc: fallback === "completed" };
  const [field, dir = "asc"] = value.split(":");
  if (!(SORT_FIELDS as readonly string[]).includes(field!) || !["asc", "desc"].includes(dir)) {
    throw new CliError("INVALID_ARGUMENT", `Invalid --sort "${value}". Use one of ${SORT_FIELDS.join(", ")} with optional :asc or :desc.`);
  }
  return { field: field as SortField, desc: dir === "desc" };
}

/** Deterministic ordering: the chosen key, then project, sortOrder, and id. Missing values sort last. */
function sortViews(rows: TaskView[], sort: { field: SortField; desc: boolean }): TaskView[] {
  const key = (t: TaskView): string | number | undefined => {
    switch (sort.field) {
      case "project": return t.projectName.toLowerCase();
      case "title": return t.title.toLowerCase();
      case "priority": return t.priority ?? 0;
      case "start": return parseApiDate(t.startDate) ?? undefined;
      case "due": return parseApiDate(t.dueDate) ?? undefined;
      case "created": return parseApiDate(t.createdTime) ?? undefined;
      case "modified": return parseApiDate(t.modifiedTime) ?? undefined;
      case "completed": return parseApiDate(t.completedTime) ?? undefined;
    }
  };
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) {
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      return (ka < kb ? -1 : 1) * dir;
    }
    return a.projectName.localeCompare(b.projectName) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);
  });
}

function textMatch(task: Task, needle: string | undefined): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return task.title.toLowerCase().includes(n) || (task.content ?? "").toLowerCase().includes(n);
}

function finishList(rt: Runtime, views: TaskView[], opts: { sort?: string; limit?: string; fields?: string }, defaultSort: SortField) {
  const fields = parseFields(opts.fields);
  const limit = parseLimit(opts.limit);
  const sorted = sortViews(views, parseSort(opts.sort, defaultSort));
  const shown = limit ? sorted.slice(0, limit) : sorted;
  if (shown.length < sorted.length) rt.out.warn(`Showing ${shown.length} of ${sorted.length} tasks (--limit).`);
  rt.out.success(
    pickFields(shown, fields),
    () => (shown.length === 0 ? "No tasks." : shown.map(taskLine).join("\n")),
    rt.metaSources(),
  );
}

/** `tasks list`: open (undone) tasks from every project, filtered locally. */
export async function tasksList(rt: Runtime, opts: ListOptions): Promise<void> {
  parseFields(opts.fields);
  const priorities = opts.priority?.split(",").map(parsePriority);
  const kinds = opts.kind?.split(",").map((k) => {
    if (!(SCHEDULE_KINDS as string[]).includes(k)) throw new CliError("INVALID_ARGUMENT", `Invalid --kind "${k}". Use ${SCHEDULE_KINDS.join(", ")}.`);
    return k as ScheduleKind;
  });
  parseLimit(opts.limit);
  parseSort(opts.sort, "project");

  const api = await rt.api(true);
  const [tz, projects] = await Promise.all([rt.timezone(), listProjectsWithInbox(api)]);
  const range = opts.from || opts.to || opts.date ? parseRange(opts, tz, rt.now) : undefined;
  const scope = opts.project ? [resolveProject(projects, opts.project).project] : projects;
  const scan = await scanOpenTasks(api, { projects: scope, includeClosed: opts.includeClosed || Boolean(opts.project), allowPartial: opts.allowPartial });
  rt.out.setCoverage(scan.coverage);
  for (const f of scan.failures) rt.out.warn(`Project "${f.projectName}" (${f.projectId}) could not be read: ${f.code}.`);

  const views = scan.tasks
    .filter((t) => !priorities || priorities.includes(t.priority ?? 0))
    .filter((t) => !opts.tag?.length || opts.tag.every((tag) => (t.tags ?? []).some((x) => x.toLowerCase() === tag.toLowerCase())))
    .filter((t) => textMatch(t, opts.search))
    .map((t) => ({ task: t, schedule: classify(t, tz) }))
    .filter(({ schedule }) => !kinds || kinds.includes(schedule.kind))
    .filter(({ schedule: s }) => {
      if (!range) return true;
      if (s.start === undefined) return false;
      return s.end !== undefined ? s.start < range.end && range.start < s.end : s.start >= range.start && s.start < range.end;
    })
    .map(({ task }) => toTaskView(task, task.projectName, "open", tz));
  finishList(rt, views, opts, "project");
}

export interface HistoryOptions {
  project?: string;
  from?: string;
  to?: string;
  date?: string;
  days?: string;
  search?: string;
  sort?: string;
  limit?: string;
  fields?: string;
}

async function projectNames(rt: Runtime): Promise<{ projects: Project[]; name: (projectId: string) => string }> {
  const projects = await listProjectsWithInbox(await rt.api(true));
  const byId = new Map(projects.map((p) => [p.id, p.name]));
  return { projects, name: (id) => byId.get(id) ?? (id.startsWith("inbox") ? "Inbox" : id) };
}

/** `tasks completed`: completion history from POST /task/completed, paged past the 200-row cap. */
export async function tasksCompleted(rt: Runtime, opts: HistoryOptions): Promise<void> {
  parseFields(opts.fields);
  parseLimit(opts.limit);
  parseSort(opts.sort, "completed");
  const api = await rt.api(true);
  const tz = await rt.timezone();
  const range = parseRange(opts, tz, rt.now);
  const { projects, name } = await projectNames(rt);
  const project = opts.project ? resolveProject(projects, opts.project).project : undefined;
  // The Inbox has no stable id to filter on server-side, so it is filtered locally.
  const serverFilter = project && project.id !== INBOX_ALIAS ? [project.id] : undefined;
  const history = await fetchCompleted(api, range, serverFilter);
  rt.out.setCoverage(history.coverage);
  history.warnings.forEach((w) => rt.out.warn(w));
  const views = history.tasks
    .filter((t) => project?.id !== INBOX_ALIAS || t.projectId.startsWith("inbox"))
    .filter((t) => textMatch(t, opts.search))
    .map((t) => toTaskView(t, name(t.projectId), "completed", tz));
  finishList(rt, views, opts, "completed");
}

/** `tasks abandoned`: won't-do tasks from POST /task/filter. */
export async function tasksAbandoned(rt: Runtime, opts: Omit<HistoryOptions, "from" | "to" | "date" | "days">): Promise<void> {
  parseFields(opts.fields);
  parseLimit(opts.limit);
  parseSort(opts.sort, "modified");
  const api = await rt.api(true);
  const tz = await rt.timezone();
  const { projects, name } = await projectNames(rt);
  const project = opts.project ? resolveProject(projects, opts.project).project : undefined;
  const ids = project ? [project.id] : projects.map((p) => p.id);
  const history = await fetchAbandoned(api, ids);
  rt.out.setCoverage(history.coverage);
  history.warnings.forEach((w) => rt.out.warn(w));
  const views = history.tasks.filter((t) => textMatch(t, opts.search)).map((t) => toTaskView(t, name(t.projectId), "abandoned", tz));
  finishList(rt, views, opts, "modified");
}

export interface BatchItemResult {
  taskId: string;
  ok: boolean;
  outcome?: "completed" | "occurrence_completed" | "abandoned";
  code?: string;
  message?: string;
}

/**
 * `tasks complete|abandon <ids...>`: ids only. Every id is checked against the open-task
 * list first, written in chunks of 50, and then verified by re-reading the affected projects.
 */
export async function tasksBatch(rt: Runtime, action: "complete" | "abandon", ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const bad = unique.filter((id) => !isObjectId(id));
  if (unique.length === 0 || bad.length > 0) {
    throw new CliError("INVALID_ARGUMENT", bad.length ? `Not task ids: ${bad.join(", ")}. Batch commands accept 24-character ids only.` : "Give at least one task id.");
  }
  const api = await rt.api();
  const scan = await scanOpenTasks(api, { includeClosed: true });
  const open = new Map(scan.tasks.map((t) => [t.id, t]));
  const results = new Map<string, BatchItemResult>();
  for (const id of unique) {
    if (!open.has(id)) {
      results.set(id, { taskId: id, ok: false, code: "TASK_NOT_OPEN", message: "Not in any open-task list (completed, abandoned, deleted, or wrong id)." });
    }
  }
  const targets = unique.filter((id) => open.has(id)).map((id) => open.get(id)!);

  if (rt.dryRun) {
    const requests = action === "abandon"
      ? chunk(targets, BATCH_LIMIT).map((c) => ({ method: "POST", path: "/task/batch", body: { update: c.map((t) => ({ id: t.id, projectId: t.projectId, status: -1 })) } }))
      : [...groupBy(targets, (t) => t.projectId)].flatMap(([projectId, ts]) => chunk(ts, BATCH_LIMIT).map((c) => ({ method: "POST", path: "/task/completeTasks", body: { projectId, taskIds: c.map((t) => t.id) } })));
    rt.out.success({ dryRun: true, requests, skipped: [...results.values()] }, () => `Dry run: ${requests.length} request(s), ${targets.length} task(s), ${results.size} skipped.`, rt.metaSources());
    return;
  }

  const attempted = new Set<string>();
  try {
    if (action === "abandon") {
      for (const c of chunk(targets, BATCH_LIMIT)) {
        c.forEach((t) => attempted.add(t.id));
        const res = await api.batch({ update: c.map((t) => ({ id: t.id, projectId: t.projectId, status: -1 })) });
        for (const [id, err] of Object.entries(res.id2error ?? {})) results.set(id, { taskId: id, ok: false, code: err, message: `Server rejected the update: ${err}` });
      }
    } else {
      for (const [projectId, ts] of groupBy(targets, (t) => t.projectId)) {
        for (const c of chunk(ts, BATCH_LIMIT)) {
          c.forEach((t) => attempted.add(t.id));
          const done = new Set(await api.completeTasks(projectId, c.map((t) => t.id)));
          for (const t of c) if (!done.has(t.id)) results.set(t.id, { taskId: t.id, ok: false, code: "NOT_COMPLETED", message: "Server did not report this task as completed." });
        }
      }
    }
  } catch (error) {
    const e = toCliError(error);
    for (const t of targets) {
      if (!attempted.has(t.id)) results.set(t.id, { taskId: t.id, ok: false, code: "NOT_ATTEMPTED", message: `Stopped before this task: ${e.code}` });
      else if (!results.has(t.id)) results.set(t.id, { taskId: t.id, ok: false, code: e.code, message: e.message });
    }
    return failBatch(results, unique);
  }

  // Verify against fresh project data.
  const affected = [...new Set(targets.filter((t) => !results.has(t.id)).map((t) => t.projectId))];
  const projectStubs = affected.map((id) => scan.projects.find((p) => p.id === id || (p.id === INBOX_ALIAS && id.startsWith("inbox"))) ?? { id, name: id });
  let after;
  try {
    after = await scanOpenTasks(api, { projects: projectStubs, includeClosed: true });
  } catch (error) {
    const e = toCliError(error);
    for (const t of targets) if (!results.has(t.id)) results.set(t.id, { taskId: t.id, ok: false, code: "VERIFY_FAILED", message: `Write sent but could not be verified: ${e.code}` });
    return failBatch(results, unique);
  }
  const stillOpen = new Map(after.tasks.map((t) => [t.id, t]));
  for (const t of targets) {
    if (results.has(t.id)) continue;
    const now = stillOpen.get(t.id);
    if (!now) results.set(t.id, { taskId: t.id, ok: true, outcome: action === "abandon" ? "abandoned" : "completed" });
    else if (action === "complete" && t.repeatFlag && (now.startDate !== t.startDate || now.dueDate !== t.dueDate)) {
      results.set(t.id, { taskId: t.id, ok: true, outcome: "occurrence_completed" });
    } else {
      results.set(t.id, { taskId: t.id, ok: false, code: "VERIFY_FAILED", message: "Task is still open after the write." });
    }
  }
  const ordered = unique.map((id) => results.get(id)!);
  if (ordered.some((r) => !r.ok)) return failBatch(results, unique);
  rt.out.success({ results: ordered }, () => ordered.map((r) => `✓ ${r.taskId} ${r.outcome}`).join("\n"), rt.metaSources());
}

function failBatch(results: Map<string, BatchItemResult>, order: string[]): never {
  const ordered = order.map((id) => results.get(id)!);
  const failed = ordered.filter((r) => !r.ok).length;
  throw new CliError("BATCH_PARTIAL_FAILURE", `${failed} of ${ordered.length} task(s) failed. See details.results.`, { results: ordered });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

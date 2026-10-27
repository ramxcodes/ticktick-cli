import { INBOX_ALIAS, type TickTickApi } from "./api";
import { CliError, toCliError } from "./errors";
import { listProjectsWithInbox, scanOpenTasks, type OpenScan } from "./scan";
import { TaskStatus, type Project, type ProjectTask, type Task } from "./types";

/**
 * Resolution rules for projects and tasks:
 * 1. An exact id always wins.
 * 2. Otherwise an exact (case-insensitive) name match; more than one is AMBIGUOUS.
 * 3. Otherwise a unique partial (substring) match; more than one is AMBIGUOUS.
 * Nothing ever picks "the first" of several candidates.
 */

export const isObjectId = (value: string) => /^[a-f0-9]{24}$/i.test(value);

export type MatchKind = "id" | "exact" | "partial";

export function matchByName<T>(items: T[], query: string, name: (item: T) => string, describe: (item: T) => string, label: string): { item: T; matchedBy: MatchKind } {
  const q = query.trim().toLowerCase();
  if (!q) throw new CliError("INVALID_ARGUMENT", `Empty ${label} name.`);
  const exact = items.filter((i) => name(i).toLowerCase() === q);
  const pool = exact.length > 0 ? exact : items.filter((i) => name(i).toLowerCase().includes(q));
  if (pool.length === 1) return { item: pool[0]!, matchedBy: exact.length > 0 ? "exact" : "partial" };
  if (pool.length === 0) throw new CliError("NOT_FOUND", `No ${label} matches "${query}".`);
  throw new CliError("AMBIGUOUS", `"${query}" matches ${pool.length} ${label}s. Use an id.`, {
    candidates: pool.map(describe),
  });
}

export function resolveProject(projects: Project[], ref: string): { project: Project; matchedBy: MatchKind } {
  const byId = projects.find((p) => p.id === ref || (ref.toLowerCase() === INBOX_ALIAS && p.id === INBOX_ALIAS));
  if (byId) return { project: byId, matchedBy: "id" };
  const { item, matchedBy } = matchByName(projects, ref, (p) => p.name, (p) => `${p.id} ${p.name}`, "project");
  return { project: item, matchedBy };
}

/** Finds an open task by id or title within a completed scan. */
export function resolveOpenTask(scan: OpenScan, ref: string): { task: ProjectTask; matchedBy: MatchKind } | undefined {
  const byId = scan.tasks.find((t) => t.id === ref);
  if (byId) return { task: byId, matchedBy: "id" };
  if (isObjectId(ref)) return undefined;
  const { item, matchedBy } = matchByName(scan.tasks, ref, (t) => t.title, (t) => `${t.id} ${t.title} (${t.projectName})`, "open task");
  return { task: item, matchedBy };
}

/**
 * Lifecycle state as far as the API can prove it:
 * - open: present in the project's undone-task list
 * - completed / abandoned: status from GET by id
 * - deleted_or_unknown: GET still returns the task with status 0, but it is not in
 *   the undone list. Deleted tasks behave exactly like this, so the CLI cannot
 *   tell "deleted" apart from other hidden states.
 */
export type TaskState = "open" | "completed" | "abandoned" | "deleted_or_unknown";

export function stateFromStatus(status: number): Exclude<TaskState, "open"> {
  if (status === TaskStatus.Completed) return "completed";
  if (status === TaskStatus.Abandoned) return "abandoned";
  return "deleted_or_unknown";
}

export interface LocatedTask {
  task: Task;
  projectName: string;
  state: TaskState;
  matchedBy: MatchKind;
}

/**
 * Finds a task by id or title. Open tasks come from a full scan; an id that is not open
 * is looked up with GET in every project (a GET with the wrong project returns 404).
 * If any of those lookups fails for another reason, NOT_FOUND cannot be proven and
 * PARTIAL_DATA is thrown instead.
 */
export async function locateTask(api: TickTickApi, ref: string, opts: { project?: string } = {}): Promise<LocatedTask & { scan: OpenScan }> {
  const projects = await listProjectsWithInbox(api);
  const scope = opts.project ? [resolveProject(projects, opts.project).project] : projects;
  const scan = await scanOpenTasks(api, { projects: scope, includeClosed: true });
  const open = resolveOpenTask(scan, ref);
  if (open) return { task: open.task, projectName: open.task.projectName, state: "open", matchedBy: open.matchedBy, scan };
  if (!isObjectId(ref)) throw new CliError("NOT_FOUND", `No open task matches "${ref}". Completed, abandoned, and deleted tasks can only be addressed by id.`);

  const lookups = scope.map((p) => (p.id === INBOX_ALIAS && scan.inboxId ? { ...p, id: scan.inboxId } : p));
  type Lookup = { project: Project; task: Task; error?: undefined } | { project: Project; task?: undefined; error: CliError };
  const results: Lookup[] = await Promise.all(
    lookups.map(async (project): Promise<Lookup> => {
      try {
        return { project, task: await api.getTask(project.id, ref) };
      } catch (error) {
        return { project, error: toCliError(error) };
      }
    }),
  );
  for (const r of results) {
    if (r.task) return { task: r.task, projectName: r.project.name, state: stateFromStatus(r.task.status), matchedBy: "id", scan };
  }
  const failures = results.filter((r) => r.error && r.error.code !== "NOT_FOUND");
  if (failures.length > 0) {
    throw new CliError("PARTIAL_DATA", `Task ${ref} was not found, but ${failures.length} project lookups failed, so it may still exist.`, {
      failures: failures.map((f) => ({ projectId: f.project.id, code: f.error?.code })),
    });
  }
  throw new CliError("NOT_FOUND", `Task ${ref} was not found in any project.`);
}

/** Like locateTask, but only an open task is acceptable (all task writes need this). */
export async function locateOpenTask(api: TickTickApi, ref: string, opts: { project?: string } = {}): Promise<{ task: ProjectTask; matchedBy: MatchKind; scan: OpenScan }> {
  const located = await locateTask(api, ref, opts);
  if (located.state !== "open") {
    throw new CliError("TASK_NOT_OPEN", `Task ${located.task.id} is ${located.state}; only open tasks can be changed.`, { taskId: located.task.id, state: located.state });
  }
  return { task: { ...located.task, projectName: located.projectName }, matchedBy: located.matchedBy, scan: located.scan };
}

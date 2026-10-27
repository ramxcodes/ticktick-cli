import { INBOX_ALIAS, RESULT_CAP, type TickTickApi } from "./api";
import { CliError, toCliError } from "./errors";
import type { Coverage } from "./output";
import { formatApiDate, parseApiDate } from "./time";
import { TaskStatus, type Project, type ProjectTask, type Task } from "./types";

/**
 * Account-wide reads with explicit coverage. A failed project read is never
 * skipped silently: it either fails the command (PARTIAL_DATA) or, with
 * allowPartial, is returned as a failure and the coverage becomes "partial".
 */

export const INBOX_NAME = "Inbox";

export interface ProjectFailure {
  projectId: string;
  projectName: string;
  code: string;
  message: string;
}

export interface OpenScan {
  projects: Project[];
  tasks: ProjectTask[];
  failures: ProjectFailure[];
  coverage: Coverage;
  /** Real Inbox project id (e.g. inbox123), when the Inbox has tasks. */
  inboxId?: string;
}

/** Projects plus a synthetic Inbox entry (GET /project omits the Inbox). */
export async function listProjectsWithInbox(api: TickTickApi): Promise<Project[]> {
  const projects = await api.listProjects();
  return [...projects, { id: INBOX_ALIAS, name: INBOX_NAME, kind: "INBOX" }];
}

/**
 * Reads undone tasks from every given project in parallel (bounded by the client).
 * Closed (archived) projects are skipped unless `includeClosed`.
 */
export async function scanOpenTasks(
  api: TickTickApi,
  opts: { projects?: Project[]; includeClosed?: boolean; allowPartial?: boolean } = {},
): Promise<OpenScan> {
  const all = opts.projects ?? (await listProjectsWithInbox(api));
  const projects = opts.includeClosed ? all : all.filter((p) => !p.closed);
  const results = await Promise.all(
    projects.map(async (project) => {
      try {
        return { project, data: await api.getProjectData(project.id) };
      } catch (error) {
        return { project, error: toCliError(error) };
      }
    }),
  );

  const byId = new Map<string, ProjectTask>();
  const failures: ProjectFailure[] = [];
  let inboxId: string | undefined;
  for (const r of results) {
    if ("error" in r && r.error) {
      if (r.error.code.startsWith("AUTH")) throw r.error;
      failures.push({ projectId: r.project.id, projectName: r.project.name, code: r.error.code, message: r.error.message });
      continue;
    }
    for (const task of r.data!.tasks) {
      if (r.project.id === INBOX_ALIAS && task.projectId) inboxId = task.projectId;
      byId.set(task.id, { ...task, projectId: task.projectId || r.project.id, projectName: r.project.name });
    }
  }

  if (failures.length > 0 && !opts.allowPartial) {
    throw new CliError(
      "PARTIAL_DATA",
      `${failures.length} of ${projects.length} project reads failed; refusing to return an incomplete task list. Re-run, or pass --allow-partial to accept partial data.`,
      { failures },
    );
  }
  return {
    projects,
    tasks: [...byId.values()],
    failures,
    coverage: failures.length > 0 ? "partial" : "complete",
    ...(inboxId ? { inboxId } : {}),
  };
}

export interface HistoryResult {
  tasks: Task[];
  coverage: Coverage;
  warnings: string[];
  pages: number;
}

const MAX_HISTORY_PAGES = 100;
const SECOND = 1000;

/**
 * Completed tasks with completedTime in [start, end), across the 200-row cap.
 *
 * /task/completed returns at most 200 rows, newest first, with inclusive bounds.
 * We walk backwards with a time cursor: after a full page, the next request ends at
 * the start of the next second after the oldest row seen, so rows sharing a timestamp
 * with the page boundary are fetched again (and de-duplicated by id) instead of lost.
 * Second-level boundaries are used because the server may ignore milliseconds.
 * If 200+ rows fall inside one second the cursor cannot split further: the result is
 * marked partial. Hitting the page limit is also reported as partial.
 */
export async function fetchCompleted(
  api: TickTickApi,
  range: { start: number; end: number },
  projectIds?: string[],
): Promise<HistoryResult> {
  const seen = new Map<string, Task>();
  const warnings: string[] = [];
  let coverage: Coverage = "complete";
  const startBound = Math.floor(range.start / SECOND) * SECOND;
  let endBound = Math.ceil(range.end / SECOND) * SECOND;

  for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
    const rows = await api.completedTasks({
      ...(projectIds ? { projectIds } : {}),
      startDate: formatApiDate(startBound),
      endDate: formatApiDate(endBound),
    });
    let oldest = Infinity;
    for (const row of rows) {
      const at = parseApiDate(row.completedTime);
      if (typeof at !== "number") {
        warnings.push(`Completed task ${row.id} has no valid completedTime; it was excluded.`);
        coverage = "partial";
        continue;
      }
      oldest = Math.min(oldest, at);
      if (at >= range.start && at < range.end && row.status === TaskStatus.Completed) seen.set(row.id, row);
    }

    if (rows.length < RESULT_CAP || oldest === Infinity) {
      return { tasks: sortByCompletedDesc([...seen.values()]), coverage, warnings, pages: page };
    }

    const oldestSecond = Math.floor(oldest / SECOND) * SECOND;
    let next = oldestSecond + SECOND;
    if (next >= endBound) {
      // 200+ completions inside [oldestSecond, endBound]: cannot split further.
      coverage = "partial";
      warnings.push(`More than ${RESULT_CAP} tasks were completed within one second near ${new Date(oldestSecond).toISOString()}; some may be missing.`);
      next = Math.min(oldestSecond, endBound - SECOND);
    }
    if (next < startBound) return { tasks: sortByCompletedDesc([...seen.values()]), coverage, warnings, pages: page };
    endBound = next;
  }

  warnings.push(`Stopped after ${MAX_HISTORY_PAGES} pages (${MAX_HISTORY_PAGES * RESULT_CAP} rows); narrow the date range for complete results.`);
  return { tasks: sortByCompletedDesc([...seen.values()]), coverage: "partial", warnings, pages: MAX_HISTORY_PAGES };
}

function sortByCompletedDesc(tasks: Task[]): Task[] {
  return tasks.sort((a, b) => (parseApiDate(b.completedTime) ?? 0) - (parseApiDate(a.completedTime) ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Abandoned ("won't do") tasks via /task/filter. The filter has no usable date
 * partition for undated tasks, so a capped answer is split per project; a project
 * that still returns 200 rows is reported as partial.
 */
export async function fetchAbandoned(api: TickTickApi, projectIds: string[]): Promise<HistoryResult> {
  const warnings: string[] = [];
  const combined = await api.filterTasks({ projectIds, status: [TaskStatus.Abandoned] });
  if (combined.length < RESULT_CAP) {
    return { tasks: combined.filter((t) => t.status === TaskStatus.Abandoned), coverage: "complete", warnings, pages: 1 };
  }
  let coverage: Coverage = "complete";
  const byId = new Map<string, Task>();
  for (const projectId of projectIds) {
    const rows = await api.filterTasks({ projectIds: [projectId], status: [TaskStatus.Abandoned] });
    if (rows.length >= RESULT_CAP) {
      coverage = "partial";
      warnings.push(`Project ${projectId} has ${RESULT_CAP}+ abandoned tasks; the API cannot return more.`);
    }
    for (const row of rows) if (row.status === TaskStatus.Abandoned) byId.set(row.id, row);
  }
  return { tasks: [...byId.values()], coverage, warnings, pages: 1 + projectIds.length };
}

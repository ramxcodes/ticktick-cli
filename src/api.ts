import { CliError } from "./errors";
import type { ApiClient } from "./http";
import type { BatchResponse, Column, Project, ProjectData, Task, TaskWrite } from "./types";

/**
 * Typed wrappers for the official TickTick Open API endpoints the CLI uses.
 * Each method validates the response shape so callers never mistake a
 * malformed or empty answer for real data.
 */

/** Server-side row cap observed on /task/completed and /task/filter. */
export const RESULT_CAP = 200;
export const BATCH_LIMIT = 50;
const PROJECT_PAGE = 200;
const MAX_PROJECT_PAGES = 50;

export const INBOX_ALIAS = "inbox";

export interface CompletedQuery {
  projectIds?: string[];
  startDate: string;
  endDate: string;
}

export interface FilterQuery {
  projectIds?: string[];
  startDate?: string;
  endDate?: string;
  priority?: number[];
  tag?: string[];
  kind?: string[];
  status?: number[];
}

function expectArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new CliError("API_ERROR", `${label} returned an unexpected response shape.`);
  return value as T[];
}

function expectTask(value: unknown, label: string): Task {
  const task = value as Partial<Task> | null;
  if (!task || typeof task.id !== "string" || typeof task.projectId !== "string") {
    throw new CliError("API_ERROR", `${label} did not return a task.`);
  }
  return task as Task;
}

export class TickTickApi {
  constructor(readonly client: ApiClient) {}

  /** All projects, paginated. The Inbox is not included (API limitation). */
  async listProjects(): Promise<Project[]> {
    const all: Project[] = [];
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const rows = expectArray<Project>(
        await this.client.get(`/project?offset=${page * PROJECT_PAGE}&limit=${PROJECT_PAGE}`),
        "GET /project",
      );
      all.push(...rows);
      if (rows.length < PROJECT_PAGE) return all;
    }
    throw new CliError("PARTIAL_DATA", `More than ${MAX_PROJECT_PAGES * PROJECT_PAGE} projects; stopped paginating.`);
  }

  /**
   * Undone tasks of one project. The API answers HTTP 200 with `{}` for an unknown
   * project id, so a missing `tasks` array is reported as NOT_FOUND, not as "empty".
   */
  async getProjectData(projectId: string): Promise<ProjectData> {
    const data = await this.client.get<Partial<ProjectData> | null>(`/project/${encodeURIComponent(projectId)}/data`);
    if (!data || !Array.isArray(data.tasks)) {
      throw new CliError("NOT_FOUND", `Project ${projectId} does not exist or is not accessible.`);
    }
    return data as ProjectData;
  }

  async getTask(projectId: string, taskId: string): Promise<Task> {
    return expectTask(
      await this.client.get(`/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`),
      "GET task",
    );
  }

  async createTask(body: TaskWrite): Promise<Task> {
    return expectTask(await this.client.write("POST", "/task", body), "POST /task");
  }

  async updateTask(taskId: string, body: TaskWrite): Promise<Task> {
    return expectTask(await this.client.write("POST", `/task/${encodeURIComponent(taskId)}`, { ...body, id: taskId }), "POST /task/{id}");
  }

  async completeTask(projectId: string, taskId: string): Promise<void> {
    await this.client.write("POST", `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`);
  }

  async deleteTask(projectId: string, taskId: string): Promise<void> {
    await this.client.write("DELETE", `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`);
  }

  /** The response is not trustworthy (a missing task still returns 200); callers must read back. */
  async moveTask(taskId: string, fromProjectId: string, toProjectId: string): Promise<void> {
    await this.client.write("POST", "/task/move", [{ fromProjectId, toProjectId, taskId }]);
  }

  async batch(body: { add?: TaskWrite[]; update?: TaskWrite[] }): Promise<BatchResponse> {
    const res = await this.client.write<BatchResponse | null>("POST", "/task/batch", body);
    if (!res || typeof res !== "object") throw new CliError("API_ERROR", "POST /task/batch returned an unexpected response.");
    return res;
  }

  /** Completes up to 50 tasks of one project. Returns the ids the server completed. */
  async completeTasks(projectId: string, taskIds: string[]): Promise<string[]> {
    return expectArray<string>(await this.client.write("POST", "/task/completeTasks", { projectId, taskIds }), "POST /task/completeTasks");
  }

  /** Completed tasks, newest first, at most RESULT_CAP rows. Both bounds inclusive. */
  async completedTasks(query: CompletedQuery): Promise<Task[]> {
    return expectArray<Task>(await this.client.query("/task/completed", query), "POST /task/completed");
  }

  /** At most RESULT_CAP rows. Date bounds apply to the task startDate. */
  async filterTasks(query: FilterQuery): Promise<Task[]> {
    return expectArray<Task>(await this.client.query("/task/filter", query), "POST /task/filter");
  }

  async preferenceTimeZone(): Promise<string | undefined> {
    const pref = await this.client.query<{ timeZone?: unknown } | null>("/preference", {});
    return typeof pref?.timeZone === "string" && pref.timeZone ? pref.timeZone : undefined;
  }

  async listColumns(projectId: string): Promise<Column[]> {
    return expectArray<Column>(await this.client.get(`/project/${encodeURIComponent(projectId)}/column`), "GET columns");
  }

  async createProject(body: { name: string; color?: string; viewMode?: string; kind?: string }): Promise<Project> {
    const project = await this.client.write<Project | null>("POST", "/project", body);
    if (!project?.id) throw new CliError("API_ERROR", "POST /project did not return a project.");
    return project;
  }

  async updateProject(projectId: string, body: { name?: string; color?: string; viewMode?: string }): Promise<Project> {
    const project = await this.client.write<Project | null>("POST", `/project/${encodeURIComponent(projectId)}`, body);
    if (!project?.id) throw new CliError("API_ERROR", "POST /project/{id} did not return a project.");
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.client.write("DELETE", `/project/${encodeURIComponent(projectId)}`);
  }
}

/**
 * Types for the official TickTick Open API (https://developer.ticktick.com/docs/openapi.md).
 * Fields marked "observed" are returned by the server but not documented.
 */

/** Task status. Documented: Abandoned -1, Normal 0, Completed 2. */
export const TaskStatus = { Abandoned: -1, Open: 0, Completed: 2 } as const;
export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Checklist item status. Documented: Normal 0, Completed 1. */
export const ItemStatus = { Open: 0, Completed: 1 } as const;

export const PRIORITIES = { none: 0, low: 1, medium: 3, high: 5 } as const;
export type PriorityName = keyof typeof PRIORITIES;

export interface ChecklistItem {
  id: string;
  title: string;
  status: number;
  sortOrder?: number;
  startDate?: string;
  isAllDay?: boolean;
  timeZone?: string;
  completedTime?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: number;
  priority?: number;
  content?: string;
  desc?: string;
  startDate?: string;
  dueDate?: string;
  isAllDay?: boolean;
  timeZone?: string;
  reminders?: string[];
  tags?: string[];
  repeatFlag?: string;
  repeatFrom?: string;
  items?: ChecklistItem[];
  sortOrder?: number;
  kind?: "TEXT" | "NOTE" | "CHECKLIST";
  parentId?: string;
  completedTime?: string;
  columnId?: string;
  /** observed */
  etag?: string;
  /** observed */
  createdTime?: string;
  /** observed */
  modifiedTime?: string;
  /** observed */
  childIds?: string[];
  /** observed */
  isFloating?: boolean;
}

export interface Project {
  id: string;
  name: string;
  color?: string;
  sortOrder?: number;
  closed?: boolean;
  groupId?: string;
  viewMode?: string;
  permission?: string;
  kind?: string;
}

export interface Column {
  id: string;
  projectId?: string;
  name: string;
  sortOrder?: number;
}

/** `GET /project/{id}/data` — contains undone tasks only. */
export interface ProjectData {
  project?: Project;
  tasks: Task[];
  columns?: Column[];
}

/** Body accepted by create (`POST /task`) and update (`POST /task/{id}`). */
export interface TaskWrite {
  id?: string;
  projectId: string;
  title?: string;
  content?: string;
  desc?: string;
  startDate?: string | null;
  dueDate?: string | null;
  isAllDay?: boolean;
  timeZone?: string;
  reminders?: string[];
  tags?: string[];
  repeatFlag?: string;
  priority?: number;
  status?: number;
  items?: Array<Partial<ChecklistItem> & { title: string }>;
  kind?: "TEXT" | "NOTE" | "CHECKLIST";
  parentId?: string;
  columnId?: string;
}

/** `POST /task/batch` response (items[] is observed, id2etag/id2error documented). */
export interface BatchResponse {
  status?: string;
  items?: Array<{ operation: string; index: number; taskId: string; etag: string | null; errorCode: string | null }>;
  id2etag?: Record<string, string>;
  id2error?: Record<string, string>;
}

/** A task annotated with the name of its project. */
export interface ProjectTask extends Task {
  projectName: string;
}

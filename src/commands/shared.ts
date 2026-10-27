import { classify, type ScheduleKind } from "../agenda";
import { CliError } from "../errors";
import type { TaskState } from "../resolve";
import { addDays, formatIso, formatLocalDate, parseUserDate, startOfLocalDay, type ParsedInput } from "../time";
import { PRIORITIES, type PriorityName, type Task } from "../types";

/** Task as printed by every command: raw API fields plus computed context. */
export interface TaskView extends Task {
  projectName: string;
  state: TaskState;
  schedule: {
    kind: ScheduleKind;
    start?: string;
    end?: string;
    at?: string;
    startDay?: string;
    endDay?: string;
    reason?: string;
  };
}

export function toTaskView(task: Task, projectName: string, state: TaskState, tz: string): TaskView {
  const s = classify(task, tz);
  const schedule: TaskView["schedule"] = { kind: s.kind };
  if (s.kind === "interval") Object.assign(schedule, { start: formatIso(s.start!, tz), end: formatIso(s.end!, tz) });
  else if (s.kind === "point" || s.kind === "deadline") schedule.at = formatIso(s.start!, tz);
  else if (s.kind === "all-day") Object.assign(schedule, { startDay: formatLocalDate(s.days!.first), endDay: formatLocalDate(addDays(s.days!.afterLast, -1)) });
  else if (s.kind === "invalid") schedule.reason = s.reason;
  return { ...task, projectName, state, schedule };
}

/** Every top-level key a TaskView can have; --fields is validated against this list. */
export const TASK_VIEW_FIELDS = [
  "id", "projectId", "projectName", "title", "status", "state", "schedule", "priority", "content", "desc",
  "startDate", "dueDate", "isAllDay", "timeZone", "reminders", "tags", "repeatFlag", "repeatFrom", "items",
  "sortOrder", "kind", "parentId", "childIds", "completedTime", "columnId", "etag", "createdTime", "modifiedTime", "isFloating",
] as const;

export function parseFields(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const fields = value.split(",").map((f) => f.trim()).filter(Boolean);
  const unknown = fields.filter((f) => !(TASK_VIEW_FIELDS as readonly string[]).includes(f));
  if (fields.length === 0 || unknown.length > 0) {
    throw new CliError("INVALID_ARGUMENT", `Unknown field(s): ${unknown.join(", ") || "(none given)"}. Valid fields: ${TASK_VIEW_FIELDS.join(", ")}.`);
  }
  return fields;
}

export function pickFields<T extends object>(rows: T[], fields: string[] | undefined): Array<Partial<T>> {
  if (!fields) return rows;
  return rows.map((row) => Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f as keyof T]])) as Partial<T>);
}

export function parsePriority(value: string): number {
  const key = value.toLowerCase();
  if (!(key in PRIORITIES)) throw new CliError("INVALID_ARGUMENT", `Invalid priority "${value}". Use none, low, medium, or high.`);
  return PRIORITIES[key as PriorityName];
}

export function priorityName(value: number | undefined): string {
  return (Object.entries(PRIORITIES).find(([, v]) => v === (value ?? 0))?.[0]) ?? String(value);
}

/** Commander collector for repeatable flags (--tag a --tag b). */
export const collect = (value: string, previous: string[] = []) => [...previous, value];

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new CliError("INVALID_ARGUMENT", "--limit must be a positive integer.");
  return Number(value);
}

/**
 * Reminder input: "at" (at the task time), "15m", "2h", "1d" (before), or a raw
 * TickTick trigger such as TRIGGER:-P0DT0H15M0S.
 */
export function parseReminder(value: string): string {
  const v = value.trim();
  if (/^TRIGGER:-?P(\d+D)?(T(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/i.test(v) && v.length > "TRIGGER:P".length) return v.toUpperCase();
  if (v.toLowerCase() === "at") return "TRIGGER:PT0S";
  const m = /^(\d+)\s*(m|h|d)$/i.exec(v);
  if (!m) throw new CliError("INVALID_ARGUMENT", `Invalid reminder "${value}". Use at, 15m, 2h, 1d, or a TRIGGER: value.`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (n === 0) return "TRIGGER:PT0S";
  const days = unit === "d" ? n : 0;
  const hours = unit === "h" ? n : 0;
  const minutes = unit === "m" ? n : 0;
  return `TRIGGER:-P${days}DT${hours}H${minutes}M0S`;
}

export interface DateFields {
  startDate?: string | null;
  dueDate?: string | null;
  isAllDay?: boolean;
}

/**
 * Turns --start/--due inputs into API date fields, interpreting local values in `tz`.
 * Date-only inputs make an all-day task unless --all-day=false; mixing date-only and
 * timed inputs is rejected. All-day spans are stored as local midnights with an
 * exclusive end (a one-day task has start == due).
 */
export function buildDates(
  input: { start?: string; due?: string; allDay?: boolean },
  tz: string,
  now: number,
  toApi: (ms: number) => string,
): DateFields {
  const start = input.start !== undefined ? parseUserDate(input.start, tz, now) : undefined;
  const due = input.due !== undefined ? parseUserDate(input.due, tz, now) : undefined;
  const given = [start, due].filter((d): d is ParsedInput => d !== undefined);
  if (given.length === 0) {
    if (input.allDay !== undefined) throw new CliError("INVALID_ARGUMENT", "--all-day needs --start or --due.");
    return {};
  }
  const allDateOnly = given.every((d) => d.dateOnly);
  const anyDateOnly = given.some((d) => d.dateOnly);
  if (input.allDay === undefined && anyDateOnly && !allDateOnly) {
    throw new CliError("INVALID_ARGUMENT", "Mix of date-only and timed values. Give both with times, or both as dates for an all-day task.");
  }
  const allDay = input.allDay ?? allDateOnly;
  if (!allDay && anyDateOnly) throw new CliError("INVALID_ARGUMENT", "A timed task needs times (e.g. 2026-10-29T14:00); date-only values make an all-day task.");
  if (allDay) {
    const first = (start ?? due)!.date;
    const last = (due ?? start)!.date;
    const firstMs = startOfLocalDay(first, tz);
    const lastMs = startOfLocalDay(last, tz);
    if (lastMs < firstMs) throw new CliError("INVALID_ARGUMENT", "--due must not be before --start.");
    const endMs = lastMs === firstMs ? firstMs : startOfLocalDay(addDays(last, 1), tz);
    return { startDate: toApi(firstMs), dueDate: toApi(endMs), isAllDay: true };
  }
  if (start && due && due.ms < start.ms) throw new CliError("INVALID_ARGUMENT", "--due must not be before --start.");
  // A timed task with only --due is a deadline; with only --start it is a point in time.
  return {
    ...(start ? { startDate: toApi(start.ms) } : {}),
    ...(due ? { dueDate: toApi(due.ms) } : {}),
    isAllDay: false,
  };
}

/** One-line human summary of a task. */
export function taskLine(view: TaskView): string {
  const mark = { open: "○", completed: "✓", abandoned: "✗", deleted_or_unknown: "?" }[view.state];
  const s = view.schedule;
  const when =
    s.kind === "interval" ? ` · ${s.start} → ${s.end}`
    : s.kind === "point" ? ` · at ${s.at}`
    : s.kind === "deadline" ? ` · due ${s.at}`
    : s.kind === "all-day" ? ` · ${s.startDay === s.endDay ? s.startDay : `${s.startDay} → ${s.endDay}`} (all day)`
    : s.kind === "invalid" ? ` · invalid dates (${s.reason})`
    : "";
  const prio = view.priority ? ` · ${priorityName(view.priority)}` : "";
  const repeat = view.repeatFlag ? " · repeats" : "";
  return `${mark} ${view.id}  ${view.title}  [${view.projectName}]${when}${prio}${repeat}`;
}

export function taskDetails(view: TaskView): string {
  const lines = [taskLine(view), `  state: ${view.state}   project: ${view.projectName} (${view.projectId})`];
  if (view.tags?.length) lines.push(`  tags: ${view.tags.join(", ")}`);
  if (view.repeatFlag) lines.push(`  repeat: ${view.repeatFlag}`);
  if (view.reminders?.length) lines.push(`  reminders: ${view.reminders.join(", ")}`);
  if (view.parentId) lines.push(`  parent: ${view.parentId}`);
  if (view.items?.length) {
    lines.push("  checklist:");
    for (const i of view.items) lines.push(`    ${i.status === 0 ? "○" : "✓"} ${i.id}  ${i.title}`);
  }
  if (view.content) lines.push("  content:", ...view.content.split("\n").map((l) => `    ${l}`));
  return lines.join("\n");
}

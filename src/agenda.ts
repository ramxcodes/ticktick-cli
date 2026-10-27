import { expandAfter, parseRRule } from "./rrule";
import { addDays, formatIso, formatLocalDate, isValidTimeZone, localDateOf, parseApiDate, startOfLocalDay, type LocalDate } from "./time";
import { TaskStatus, type Task } from "./types";

/**
 * Calendar classification and agenda building.
 *
 * Classification of one task (all intervals are half-open [start, end)):
 *   start < due           -> interval  (blocks time)
 *   start == due / start  -> point     (a moment; does not block time)
 *   due only              -> deadline  (does not block time)
 *   isAllDay              -> all-day   (date span; does not block hours)
 *   no dates              -> unscheduled
 *   start > due, bad date -> invalid   (reported, never placed)
 *
 * All-day spans: due == start means one day; a later due at local midnight is an
 * exclusive end (observed TickTick convention), otherwise the due day is included.
 */

export type ScheduleKind = "interval" | "point" | "deadline" | "all-day" | "unscheduled" | "invalid";

export interface Schedule {
  kind: ScheduleKind;
  /** Interval start, point time, deadline time, or first all-day midnight. */
  start?: number;
  /** Interval end (exclusive) or all-day end midnight (exclusive). */
  end?: number;
  /** All-day span as local dates [first, afterLast). */
  days?: { first: LocalDate; afterLast: LocalDate };
  reason?: string;
}

export function taskTimeZone(task: Task, fallback: string): string {
  return task.timeZone && isValidTimeZone(task.timeZone) ? task.timeZone : fallback;
}

export function classify(task: Task, fallbackTz: string): Schedule {
  const start = parseApiDate(task.startDate);
  const due = parseApiDate(task.dueDate);
  if (start === null || due === null) return { kind: "invalid", reason: "malformed startDate or dueDate" };
  if (start === undefined && due === undefined) return { kind: "unscheduled" };
  if (start !== undefined && due !== undefined && start > due) return { kind: "invalid", reason: "startDate is after dueDate" };

  if (task.isAllDay) {
    const tz = taskTimeZone(task, fallbackTz);
    const first = localDateOf((start ?? due)!, tz);
    let afterLast = addDays(first, 1);
    if (start !== undefined && due !== undefined && due > start) {
      const dueDay = localDateOf(due, tz);
      afterLast = startOfLocalDay(dueDay, tz) === due ? dueDay : addDays(dueDay, 1);
    }
    return { kind: "all-day", start: startOfLocalDay(first, tz), end: startOfLocalDay(afterLast, tz), days: { first, afterLast } };
  }
  if (start !== undefined && due !== undefined && start < due) return { kind: "interval", start, end: due };
  if (start !== undefined) return { kind: "point", start };
  return { kind: "deadline", start: due! };
}

export type OccurrenceSource = "server" | "calculated";

export interface AgendaEntry {
  taskId: string;
  projectId: string;
  projectName: string;
  title: string;
  status: "open" | "completed";
  kind: Exclude<ScheduleKind, "unscheduled" | "invalid">;
  blocksTime: boolean;
  /** interval: start/end. point/deadline: at. all-day: startDay/endDay (inclusive). */
  start?: string;
  end?: string;
  at?: string;
  startDay?: string;
  endDay?: string;
  timeZone: string;
  priority: number;
  recurring: boolean;
  /** Present for recurring series: index 0 is the server's current occurrence. */
  occurrence?: { index: number; source: OccurrenceSource };
}

export interface InvalidEntry {
  taskId: string;
  title: string;
  projectName: string;
  reason: string;
}

export interface Conflict {
  a: string;
  b: string;
  overlapStart: string;
  overlapEnd: string;
}

export interface Agenda {
  range: { start: string; end: string };
  entries: AgendaEntry[];
  busy: Array<{ start: string; end: string }>;
  conflicts: Conflict[];
  invalid: InvalidEntry[];
  unscheduledCount: number;
  recurrence: {
    calculatedOccurrences: number;
    unsupportedSeries: Array<{ taskId: string; title: string; repeatFlag: string; reason: string }>;
    exceptionsVisible: false;
  };
}

export interface AgendaInput {
  task: Task;
  projectName: string;
}

const MAX_OCCURRENCES_PER_SERIES = 1000;

interface Placed {
  entry: AgendaEntry;
  start: number;
  end: number;
}

function overlaps(s: Schedule, rangeStart: number, rangeEnd: number): boolean {
  if (s.start === undefined) return false;
  if (s.end !== undefined) return s.start < rangeEnd && rangeStart < s.end;
  return s.start >= rangeStart && s.start < rangeEnd;
}

/** Builds the agenda for [rangeStart, rangeEnd) and records anything uncertain in `warn`. */
export function buildAgenda(inputs: AgendaInput[], rangeStart: number, rangeEnd: number, tz: string, warn: (message: string) => void): Agenda {
  const placed: Placed[] = [];
  const invalid: InvalidEntry[] = [];
  const unsupportedSeries: Agenda["recurrence"]["unsupportedSeries"] = [];
  let unscheduledCount = 0;
  let calculated = 0;

  const place = (task: Task, projectName: string, s: Schedule, occurrence?: AgendaEntry["occurrence"]) => {
    const kind = s.kind;
    if (kind === "unscheduled" || kind === "invalid" || s.start === undefined || !overlaps(s, rangeStart, rangeEnd)) return;
    const entry: AgendaEntry = {
      taskId: task.id,
      projectId: task.projectId,
      projectName,
      title: task.title,
      status: task.status === TaskStatus.Completed ? "completed" : "open",
      kind,
      blocksTime: kind === "interval",
      timeZone: taskTimeZone(task, tz),
      priority: task.priority ?? 0,
      recurring: Boolean(task.repeatFlag),
      ...(occurrence ? { occurrence } : {}),
    };
    if (kind === "interval") Object.assign(entry, { start: formatIso(s.start, tz), end: formatIso(s.end!, tz) });
    else if (kind === "all-day") Object.assign(entry, { startDay: formatLocalDate(s.days!.first), endDay: formatLocalDate(addDays(s.days!.afterLast, -1)) });
    else entry.at = formatIso(s.start, tz);
    placed.push({ entry, start: s.start, end: s.end ?? s.start });
  };

  for (const { task, projectName } of inputs) {
    const s = classify(task, tz);
    if (s.kind === "unscheduled") {
      unscheduledCount++;
      continue;
    }
    if (s.kind === "invalid") {
      invalid.push({ taskId: task.id, title: task.title, projectName, reason: s.reason! });
      continue;
    }
    const isOpenSeries = Boolean(task.repeatFlag) && task.status !== TaskStatus.Completed;
    if (!isOpenSeries) {
      place(task, projectName, s);
      continue;
    }

    // Recurring series: the stored dates are the server's current occurrence.
    place(task, projectName, s, { index: 0, source: "server" });
    const seriesTz = taskTimeZone(task, tz);
    if (rangeStart < s.start! && formatLocalDate(localDateOf(rangeStart, seriesTz)) < formatLocalDate(localDateOf(s.start!, seriesTz))) {
      warn("Recurring occurrences before a series' current date are not reconstructed. Completed ones are separate tasks (use --include-completed); skipped ones are not exposed by the API.");
    }
    const parsed = parseRRule(task.repeatFlag!);
    const reason = !parsed.rule
      ? `unsupported rule parts: ${parsed.unsupported.join(", ")}`
      : parsed.rule.count !== undefined
        ? "COUNT rules: the API does not say how many occurrences remain"
        : task.repeatFrom === "1"
          ? "repeats from completion date: future dates depend on when it is completed"
          : undefined;
    if (reason) {
      if (rangeEnd > s.start!) unsupportedSeries.push({ taskId: task.id, title: task.title, repeatFlag: task.repeatFlag!, reason });
      continue;
    }
    const duration = (s.end ?? s.start!) - s.start!;
    const { instants, truncated } = expandAfter(parsed.rule!, s.start!, seriesTz, rangeEnd, MAX_OCCURRENCES_PER_SERIES);
    if (truncated) warn(`Series ${task.id} has more than ${MAX_OCCURRENCES_PER_SERIES} occurrences in range; later ones are omitted.`);
    instants.forEach((at, i) => {
      let occ: Schedule;
      if (s.kind === "all-day") {
        const first = localDateOf(at, seriesTz);
        const spanDays = Math.round(duration / 86_400_000);
        const afterLast = addDays(first, Math.max(1, spanDays));
        occ = { kind: "all-day", start: at, end: startOfLocalDay(afterLast, seriesTz), days: { first, afterLast } };
      } else {
        occ = { kind: s.kind, start: at, ...(s.end !== undefined ? { end: at + duration } : {}) };
      }
      const before = placed.length;
      place(task, projectName, occ, { index: i + 1, source: "calculated" });
      if (placed.length > before) calculated++;
    });
  }

  if (calculated > 0) {
    warn(`${calculated} occurrence(s) were calculated from recurrence rules. TickTick does not expose skipped or edited occurrences, so calculated entries may be wrong.`);
  }

  placed.sort((x, y) => x.start - y.start || x.end - y.end || x.entry.taskId.localeCompare(y.entry.taskId) || (x.entry.occurrence?.index ?? 0) - (y.entry.occurrence?.index ?? 0));
  const intervals = placed.filter((p) => p.entry.blocksTime);

  const conflicts: Conflict[] = [];
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length && intervals[j]!.start < intervals[i]!.end; j++) {
      const a = intervals[i]!;
      const b = intervals[j]!;
      conflicts.push({
        a: a.entry.taskId,
        b: b.entry.taskId,
        overlapStart: formatIso(Math.max(a.start, b.start), tz),
        overlapEnd: formatIso(Math.min(a.end, b.end), tz),
      });
    }
  }

  const busy: Array<{ start: number; end: number }> = [];
  for (const iv of intervals) {
    const last = busy[busy.length - 1];
    if (last && iv.start < last.end) last.end = Math.max(last.end, iv.end);
    else busy.push({ start: iv.start, end: iv.end });
  }

  return {
    range: { start: formatIso(rangeStart, tz), end: formatIso(rangeEnd, tz) },
    entries: placed.map((p) => p.entry),
    busy: busy.map((b) => ({ start: formatIso(b.start, tz), end: formatIso(b.end, tz) })),
    conflicts,
    invalid,
    unscheduledCount,
    recurrence: { calculatedOccurrences: calculated, unsupportedSeries, exceptionsVisible: false },
  };
}

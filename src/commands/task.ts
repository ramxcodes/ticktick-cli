import { INBOX_ALIAS, type TickTickApi } from "../api";
import { readStdinLine } from "../auth";
import { CliError, toCliError } from "../errors";
import { findOp, runOnce, validateOpId, type OpOutcome, type OpRecord } from "../ops";
import { isObjectId, locateOpenTask, locateTask, resolveProject } from "../resolve";
import { parseRRule } from "../rrule";
import type { Runtime } from "../runtime";
import { listProjectsWithInbox } from "../scan";
import { addDays, formatApiDate, formatIso, formatLocalDate, parseApiDate } from "../time";
import { classify } from "../agenda";
import { TaskStatus, type ProjectTask, type Task, type TaskWrite } from "../types";
import { buildDates, parseFields, parsePriority, parseReminder, pickFields, taskDetails, taskLine, toTaskView, type TaskView } from "./shared";

export interface PlannedRequest {
  method: "POST" | "DELETE";
  path: string;
  body?: unknown;
}

/** Prints the requests a mutation would send. No write reaches the API in dry-run mode. */
export function emitDryRun(rt: Runtime, requests: PlannedRequest[], extra: Record<string, unknown> = {}): void {
  rt.out.success({ dryRun: true, requests, ...extra }, () => [`Dry run — ${requests.length} request(s) not sent:`, ...requests.map((r) => `  ${r.method} ${r.path} ${r.body ? JSON.stringify(r.body) : ""}`)].join("\n"), rt.metaSources());
}

function checkEtag(task: Task, ifEtag: string | undefined): void {
  if (ifEtag !== undefined && task.etag !== ifEtag) {
    throw new CliError("CONFLICT", `Task ${task.id} changed since it was read (etag ${task.etag ?? "none"}, expected ${ifEtag}). Read it again before writing.`, { taskId: task.id, etag: task.etag });
  }
}

function validateRepeat(value: string): string {
  if (value.toLowerCase() === "none") return "";
  const rule = value.toUpperCase().startsWith("RRULE:") ? value : `RRULE:${value}`;
  if (!/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)\b/i.test(rule)) {
    throw new CliError("INVALID_ARGUMENT", `Invalid --repeat "${value}". Example: FREQ=WEEKLY;BYDAY=MO,WE or "none".`);
  }
  return rule.toUpperCase();
}

const sameInstant = (a: string | null | undefined, b: string | undefined) => (a ? parseApiDate(a) : undefined) === (b ? parseApiDate(b) : undefined);
const sameSet = (a: string[] = [], b: string[] = []) => {
  const norm = (x: string[]) => [...new Set(x.map((v) => v.toLowerCase()))].sort().join("\u0000");
  return norm(a) === norm(b);
};

/** Compares the fields a write asked for with what the server stored. */
export function writeMismatches(expected: TaskWrite, actual: Task): Array<{ field: string; expected: unknown; actual: unknown }> {
  const out: Array<{ field: string; expected: unknown; actual: unknown }> = [];
  const check = (field: string, ok: boolean, exp: unknown, act: unknown) => {
    if (!ok) out.push({ field, expected: exp, actual: act });
  };
  const inboxAlias = expected.projectId === INBOX_ALIAS && actual.projectId.startsWith("inbox");
  check("projectId", actual.projectId === expected.projectId || inboxAlias, expected.projectId, actual.projectId);
  if (expected.title !== undefined) check("title", actual.title === expected.title, expected.title, actual.title);
  if (expected.content !== undefined) check("content", (actual.content ?? "") === expected.content, expected.content, actual.content);
  if (expected.priority !== undefined) check("priority", (actual.priority ?? 0) === expected.priority, expected.priority, actual.priority);
  if (expected.status !== undefined) check("status", actual.status === expected.status, expected.status, actual.status);
  if (expected.startDate !== undefined) check("startDate", sameInstant(expected.startDate, actual.startDate), expected.startDate, actual.startDate);
  if (expected.dueDate !== undefined) check("dueDate", sameInstant(expected.dueDate, actual.dueDate), expected.dueDate, actual.dueDate);
  if (expected.isAllDay !== undefined && (expected.startDate || expected.dueDate)) check("isAllDay", Boolean(actual.isAllDay) === expected.isAllDay, expected.isAllDay, actual.isAllDay);
  if (expected.tags !== undefined) check("tags", sameSet(expected.tags, actual.tags), expected.tags, actual.tags);
  if (expected.reminders !== undefined) check("reminders", sameSet(expected.reminders, actual.reminders), expected.reminders, actual.reminders);
  if (expected.repeatFlag !== undefined) check("repeatFlag", (actual.repeatFlag ?? "") === expected.repeatFlag, expected.repeatFlag, actual.repeatFlag);
  if (expected.parentId !== undefined) check("parentId", actual.parentId === expected.parentId, expected.parentId, actual.parentId);
  if (expected.columnId !== undefined) check("columnId", actual.columnId === expected.columnId, expected.columnId, actual.columnId);
  if (expected.items !== undefined) {
    const titles = (actual.items ?? []).map((i) => i.title);
    check("items", expected.items.every((i) => titles.includes(i.title)), expected.items.map((i) => i.title), titles);
  }
  return out;
}

function throwIfMismatch(task: Task, expected: TaskWrite, verb: string): void {
  const mismatches = writeMismatches(expected, task);
  if (mismatches.length > 0) {
    throw new CliError("VERIFY_FAILED", `Task ${task.id} was ${verb}, but the server did not store: ${mismatches.map((m) => m.field).join(", ")}.`, { taskId: task.id, mismatches });
  }
}

async function confirm(rt: Runtime, yes: boolean | undefined, question: string): Promise<void> {
  if (yes) return;
  if (rt.out.json || !process.stdin.isTTY) {
    throw new CliError("CONFIRMATION_REQUIRED", `${question} Pass --yes to confirm non-interactively.`);
  }
  process.stderr.write(`${question} [y/N] `);
  if (!/^y(es)?$/i.test(await readStdinLine())) throw new CliError("CONFIRMATION_REQUIRED", "Not confirmed; nothing was changed.");
}

const show = (rt: Runtime, data: { task: TaskView } & Record<string, unknown>, prefix: string) =>
  rt.out.success(data, (d) => `${prefix}\n${taskDetails(d.task)}`, rt.metaSources());

export async function taskGet(rt: Runtime, ref: string, opts: { project?: string; fields?: string }): Promise<void> {
  const fields = parseFields(opts.fields);
  const api = await rt.api(true);
  const [located, tz] = await Promise.all([locateTask(api, ref, opts), rt.timezone()]);
  if (located.state === "deleted_or_unknown") {
    rt.out.warn("The task exists but is not in its project's open list. It was probably deleted; the API does not say.");
  }
  const view = toTaskView(located.task, located.projectName, located.state, tz);
  rt.out.success(pickFields([view], fields)[0]!, () => taskDetails(view), rt.metaSources());
}

export interface CreateOptions {
  project?: string;
  content?: string;
  priority?: string;
  start?: string;
  due?: string;
  allDay?: boolean;
  tag?: string[];
  reminder?: string[];
  repeat?: string;
  parent?: string;
  kind?: string;
  item?: string[];
  column?: string;
  opId?: string;
}

export async function taskCreate(rt: Runtime, title: string, opts: CreateOptions): Promise<void> {
  if (!title.trim()) throw new CliError("INVALID_ARGUMENT", "The task title must not be empty.");
  if (!opts.project && !opts.parent) throw new CliError("INVALID_ARGUMENT", "--project is required (or --parent for a subtask).");
  const priority = opts.priority !== undefined ? parsePriority(opts.priority) : undefined;
  const reminders = opts.reminder?.map(parseReminder);
  const repeatFlag = opts.repeat !== undefined ? validateRepeat(opts.repeat) : undefined;
  const kind = opts.kind !== undefined ? ({ text: "TEXT", note: "NOTE" } as const)[opts.kind.toLowerCase() as "text"] : undefined;
  if (opts.kind !== undefined && !kind) throw new CliError("INVALID_ARGUMENT", "--kind must be text or note.");
  const opId = opts.opId !== undefined ? validateOpId(opts.opId) : undefined;

  const api = await rt.api();
  const tz = await rt.timezone();
  const dates = buildDates({ start: opts.start, due: opts.due, allDay: opts.allDay }, tz, rt.now, formatApiDate);
  if (repeatFlag && !dates.startDate && !dates.dueDate) throw new CliError("INVALID_ARGUMENT", "--repeat needs --start or --due.");
  if (reminders?.length && !dates.startDate && !dates.dueDate) throw new CliError("INVALID_ARGUMENT", "--reminder needs --start or --due.");
  if (repeatFlag && parseRRule(repeatFlag).unsupported.length) {
    rt.out.warn(`The rule is accepted by TickTick but this CLI cannot expand it (${parseRRule(repeatFlag).unsupported.join(", ")}); agenda will mark it unsupported.`);
  }

  const projects = await listProjectsWithInbox(api);
  let projectId: string;
  let projectName: string;
  let parentId: string | undefined;
  if (opts.parent) {
    const parent = await locateOpenTask(api, opts.parent);
    if (opts.project) {
      const p = resolveProject(projects, opts.project).project;
      if (p.id !== parent.task.projectId && !(p.id === INBOX_ALIAS && parent.task.projectId.startsWith("inbox"))) {
        throw new CliError("INVALID_ARGUMENT", "A subtask must be in its parent's project; drop --project or use the parent's project.");
      }
    }
    projectId = parent.task.projectId;
    projectName = parent.task.projectName;
    parentId = parent.task.id;
  } else {
    const p = resolveProject(projects, opts.project!).project;
    // Prefer the real Inbox id; the "inbox" alias is only a fallback when the Inbox is empty.
    projectId = p.id === INBOX_ALIAS ? ((await findInboxId(api)) ?? INBOX_ALIAS) : p.id;
    projectName = p.name;
  }

  const body: TaskWrite = {
    projectId,
    title,
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...dates,
    ...(dates.startDate || dates.dueDate ? { timeZone: tz } : {}),
    ...(opts.tag?.length ? { tags: opts.tag } : {}),
    ...(reminders?.length ? { reminders } : {}),
    ...(repeatFlag ? { repeatFlag } : {}),
    ...(parentId ? { parentId } : {}),
    ...(kind ? { kind } : {}),
    ...(opts.item?.length ? { items: opts.item.map((t) => ({ title: t })) } : {}),
    ...(opts.column ? { columnId: opts.column } : {}),
  };
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path: "/task", body }]);

  let mismatchTask: Task | undefined;
  const execute = async () => {
    const created = await api.createTask(body);
    if (writeMismatches(body, created).length > 0) mismatchTask = created;
    return { result: created, record: { taskId: created.id, projectId: created.projectId, ...(created.etag ? { etag: created.etag } : {}) } };
  };

  if (!opId) {
    const { result } = await execute();
    if (mismatchTask) throwIfMismatch(mismatchTask, body, "created");
    return show(rt, { task: toTaskView(result, projectName, "open", tz), replayed: false }, `✓ Created ${result.id}`);
  }
  const run = await runOnce(opId, "task.create", body, execute, { title, projectId });
  if (run.replayed) return replayCreate(rt, api, run.record, projectName, tz);
  if (mismatchTask) throwIfMismatch(mismatchTask, body, "created");
  show(rt, { task: toTaskView(run.value, projectName, "open", tz), replayed: false, opId }, `✓ Created ${run.value.id}`);
}

/** A repeated --op-id: confirm the recorded task still exists and report it without writing. */
async function replayCreate(rt: Runtime, api: TickTickApi, record: OpRecord, projectName: string, tz: string): Promise<void> {
  let task: Task;
  try {
    task = await api.getTask(record.projectId!, record.taskId!);
  } catch (error) {
    if (toCliError(error).code === "NOT_FOUND") {
      throw new CliError("REMOTE_MISSING", `Operation ${record.opId} created task ${record.taskId}, which no longer exists (moved or removed). It was not recreated.`, { operation: record });
    }
    throw error;
  }
  if (record.etag && task.etag !== record.etag) rt.out.warn(`Task ${task.id} was modified after this operation created it.`);
  const state = task.status === TaskStatus.Open ? "open" : task.status === TaskStatus.Completed ? "completed" : "abandoned";
  show(rt, { task: toTaskView(task, projectName, state, tz), replayed: true, opId: record.opId }, `↺ Already created ${task.id} (operation ${record.opId}); nothing written.`);
}

export interface UpdateOptions {
  project?: string;
  title?: string;
  content?: string;
  priority?: string;
  start?: string;
  due?: string;
  allDay?: boolean;
  clearStart?: boolean;
  clearDue?: boolean;
  tag?: string[];
  addTag?: string[];
  removeTag?: string[];
  reminder?: string[];
  clearReminders?: boolean;
  repeat?: string;
  column?: string;
  ifEtag?: string;
}

export async function taskUpdate(rt: Runtime, ref: string, opts: UpdateOptions): Promise<void> {
  if (opts.title !== undefined && !opts.title.trim()) throw new CliError("INVALID_ARGUMENT", "--title must not be empty.");
  if (opts.tag && (opts.addTag || opts.removeTag)) throw new CliError("INVALID_ARGUMENT", "Use --tag (replace all) or --add-tag/--remove-tag, not both.");
  if (opts.reminder && opts.clearReminders) throw new CliError("INVALID_ARGUMENT", "Use --reminder or --clear-reminders, not both.");
  if ((opts.start && opts.clearStart) || (opts.due && opts.clearDue)) throw new CliError("INVALID_ARGUMENT", "Cannot set and clear the same date.");
  const priority = opts.priority !== undefined ? parsePriority(opts.priority) : undefined;
  const reminders = opts.clearReminders ? [] : opts.reminder?.map(parseReminder);
  const repeatFlag = opts.repeat !== undefined ? validateRepeat(opts.repeat) : undefined;

  const api = await rt.api();
  const [{ task }, tz] = await Promise.all([locateOpenTask(api, ref, opts), rt.timezone()]);
  checkEtag(task, opts.ifEtag);

  const body: TaskWrite = { projectId: task.projectId };
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.content !== undefined) body.content = opts.content;
  if (priority !== undefined) body.priority = priority;
  if (opts.column !== undefined) body.columnId = opts.column;
  if (reminders !== undefined) body.reminders = reminders;
  if (repeatFlag !== undefined) body.repeatFlag = repeatFlag;
  if (opts.tag) body.tags = opts.tag;
  else if (opts.addTag || opts.removeTag) {
    const remove = new Set((opts.removeTag ?? []).map((t) => t.toLowerCase()));
    body.tags = [...new Set([...(task.tags ?? []), ...(opts.addTag ?? [])])].filter((t) => !remove.has(t.toLowerCase()));
  }

  if (opts.start !== undefined || opts.due !== undefined || opts.allDay !== undefined) {
    // The date the user did not name is fed back in as it is now, so only the named one changes
    // and the result is validated as a whole (start <= due, all-day vs timed).
    const current = classify(task, tz);
    const keep = (which: "start" | "due"): string | undefined => {
      const ms = parseApiDate(which === "start" ? task.startDate : task.dueDate);
      if (typeof ms !== "number" || current.kind === "invalid") return undefined;
      if (current.kind === "all-day") return formatLocalDate(which === "start" ? current.days!.first : addDays(current.days!.afterLast, -1));
      return formatIso(ms, tz);
    };
    const dates = buildDates(
      {
        start: opts.start ?? (opts.clearStart ? undefined : keep("start")),
        due: opts.due ?? (opts.clearDue ? undefined : keep("due")),
        allDay: opts.allDay,
      },
      tz,
      rt.now,
      formatApiDate,
    );
    Object.assign(body, dates, { timeZone: tz });
  }
  if (opts.clearStart) body.startDate = null;
  if (opts.clearDue) body.dueDate = null;
  if ((opts.clearStart || opts.clearDue) && task.repeatFlag && repeatFlag === undefined) {
    rt.out.warn("Clearing dates on a recurring task can also clear its recurrence rule (observed TickTick behaviour).");
  }

  if (Object.keys(body).length === 1) throw new CliError("INVALID_ARGUMENT", "Nothing to update. Pass at least one field flag.");
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path: `/task/${task.id}`, body: { ...body, id: task.id } }]);

  const updated = await api.updateTask(task.id, body);
  throwIfMismatch(updated, body, "updated");
  show(rt, { task: toTaskView(updated, task.projectName, "open", tz) }, `✓ Updated ${updated.id}`);
}

export async function taskComplete(rt: Runtime, ref: string, opts: { project?: string; ifEtag?: string; opId?: string }): Promise<void> {
  const opId = opts.opId !== undefined ? validateOpId(opts.opId) : undefined;
  // A confirmed earlier run is replayed before lookup: the task is no longer open by now.
  const prior = opId ? await findOp(opId) : undefined;
  if (prior?.state === "succeeded" && prior.command === "task.complete") {
    if (isObjectId(ref) && prior.taskId !== ref) {
      throw new CliError("OP_ID_CONFLICT", `Operation id ${opId} was used to complete task ${prior.taskId}, not ${ref}.`, { previous: prior });
    }
    return rt.out.success({ taskId: prior.taskId, replayed: true, opId }, () => `↺ Operation ${opId} already completed ${prior.taskId}; nothing written.`, rt.metaSources());
  }
  const api = await rt.api();
  const [{ task }, tz] = await Promise.all([locateOpenTask(api, ref, opts), rt.timezone()]);
  checkEtag(task, opts.ifEtag);
  const path = `/project/${task.projectId}/task/${task.id}/complete`;
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path }]);

  const execute = async (): Promise<OpOutcome<{ outcome: "completed" | "occurrence_completed"; after: Task }>> => {
    await api.completeTask(task.projectId, task.id);
    const after = await api.getTask(task.projectId, task.id);
    if (after.status === TaskStatus.Completed) return { result: { outcome: "completed", after }, record: { taskId: task.id, projectId: task.projectId } };
    if (task.repeatFlag && (after.startDate !== task.startDate || after.dueDate !== task.dueDate)) {
      return { result: { outcome: "occurrence_completed", after }, record: { taskId: task.id, projectId: task.projectId } };
    }
    throw new CliError("VERIFY_FAILED", `Completion of ${task.id} was sent, but the task is still open with the same dates.`, { taskId: task.id });
  };
  // The occurrence dates are part of the fingerprint, so one op id completes one occurrence.
  const request = { taskId: task.id, startDate: task.startDate, dueDate: task.dueDate };
  const run = opId ? await runOnce(opId, "task.complete", request, execute, { taskId: task.id, projectId: task.projectId }) : { replayed: false as const, value: (await execute()).result };
  if (run.replayed) {
    return rt.out.success({ taskId: task.id, replayed: true, opId }, () => `↺ Operation ${opId} already completed ${task.id}; nothing written.`, rt.metaSources());
  }
  const { outcome, after } = run.value;
  const view = toTaskView(after, task.projectName, outcome === "completed" ? "completed" : "open", tz);
  const note = outcome === "occurrence_completed" ? `✓ Completed one occurrence; next: ${view.schedule.start ?? view.schedule.at ?? view.schedule.startDay}` : `✓ Completed ${task.id}`;
  show(rt, { task: view, outcome, replayed: false }, note);
}

export async function taskAbandon(rt: Runtime, ref: string, opts: { project?: string; ifEtag?: string }): Promise<void> {
  const api = await rt.api();
  const [{ task }, tz] = await Promise.all([locateOpenTask(api, ref, opts), rt.timezone()]);
  checkEtag(task, opts.ifEtag);
  const body: TaskWrite = { projectId: task.projectId, status: TaskStatus.Abandoned };
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path: `/task/${task.id}`, body: { ...body, id: task.id } }]);
  const updated = await api.updateTask(task.id, body);
  throwIfMismatch(updated, body, "abandoned");
  show(rt, { task: toTaskView(updated, task.projectName, "abandoned", tz) }, `✗ Abandoned ${task.id}`);
}

export async function taskDelete(rt: Runtime, ref: string, opts: { yes?: boolean; ifEtag?: string }): Promise<void> {
  if (!isObjectId(ref)) throw new CliError("INVALID_ARGUMENT", "task delete needs a task id (24 hex characters), never a title.");
  const api = await rt.api();
  const located = await locateTask(api, ref);
  checkEtag(located.task, opts.ifEtag);
  const { task } = located;
  const path = `/project/${task.projectId}/task/${task.id}`;
  if (rt.dryRun) return emitDryRun(rt, [{ method: "DELETE", path }]);
  await confirm(rt, opts.yes, `Delete task ${task.id} "${task.title}" (${located.state})?`);
  await api.deleteTask(task.projectId, task.id);

  let verified = false;
  if (located.state === "open") {
    const data = await api.getProjectData(task.projectId);
    if (data.tasks.some((t) => t.id === task.id)) throw new CliError("VERIFY_FAILED", `Delete of ${task.id} was sent, but the task is still in the open list.`, { taskId: task.id });
    verified = true;
  } else {
    rt.out.warn(`The API cannot confirm deletion of a ${located.state} task; the request was accepted.`);
  }
  rt.out.success({ taskId: task.id, projectId: task.projectId, deleted: true, verified }, () => `✓ Deleted ${task.id}${verified ? "" : " (unverified)"}`, rt.metaSources());
}

export async function taskMove(rt: Runtime, ref: string, opts: { project?: string; to?: string; column?: string; ifEtag?: string }): Promise<void> {
  if (!opts.to && !opts.column) throw new CliError("INVALID_ARGUMENT", "Pass --to <project> and/or --column <columnId>.");
  const api = await rt.api();
  const [{ task, scan }, tz, projects] = await Promise.all([locateOpenTask(api, ref, opts), rt.timezone(), listProjectsWithInbox(api)]);
  checkEtag(task, opts.ifEtag);

  let targetId = task.projectId;
  let targetName = task.projectName;
  if (opts.to) {
    const target = resolveProject(projects, opts.to).project;
    targetName = target.name;
    if (target.id === INBOX_ALIAS) {
      const inboxId = task.projectId.startsWith("inbox") ? task.projectId : scan.inboxId ?? (await findInboxId(api));
      if (!inboxId) throw new CliError("UNSUPPORTED_CAPABILITY", "The Inbox project id is only visible when the Inbox has at least one open task. Create a task in the Inbox first.");
      targetId = inboxId;
    } else targetId = target.id;
  }
  const moving = targetId !== task.projectId;
  if (!moving && !opts.column) {
    return rt.out.success({ task: toTaskView(task, task.projectName, "open", tz), moved: false }, () => `Task ${task.id} is already in ${task.projectName}; nothing to do.`, rt.metaSources());
  }
  const requests: PlannedRequest[] = [];
  if (moving) requests.push({ method: "POST", path: "/task/move", body: [{ fromProjectId: task.projectId, toProjectId: targetId, taskId: task.id }] });
  if (opts.column) requests.push({ method: "POST", path: `/task/${task.id}`, body: { id: task.id, projectId: targetId, columnId: opts.column } });
  if (rt.dryRun) return emitDryRun(rt, requests);

  let after: Task = task;
  if (moving) {
    await api.moveTask(task.id, task.projectId, targetId);
    // The move endpoint answers 200 even for unknown tasks, so read back from the target.
    try {
      after = await api.getTask(targetId, task.id);
    } catch (error) {
      throw new CliError("VERIFY_FAILED", `Move of ${task.id} was sent, but the task is not readable in the target project (${toCliError(error).code}).`, { taskId: task.id, targetProjectId: targetId });
    }
    if (after.projectId !== targetId) throw new CliError("VERIFY_FAILED", `Move of ${task.id} was sent, but it is still in ${after.projectId}.`, { taskId: task.id });
  }
  if (opts.column) {
    const body: TaskWrite = { projectId: targetId, columnId: opts.column };
    after = await api.updateTask(task.id, body);
    throwIfMismatch(after, body, "moved");
  }
  show(rt, { task: toTaskView(after, targetName, "open", tz), moved: true, fromProjectId: task.projectId }, `✓ Moved ${task.id} to ${targetName}${opts.column ? ` (column ${opts.column})` : ""}`);
}

async function findInboxId(api: TickTickApi): Promise<string | undefined> {
  const data = await api.getProjectData(INBOX_ALIAS);
  return data.tasks.find((t) => t.projectId)?.projectId;
}

export async function taskSubtasks(rt: Runtime, ref: string, opts: { project?: string }): Promise<void> {
  const api = await rt.api(true);
  const [located, tz] = await Promise.all([locateTask(api, ref, opts), rt.timezone()]);
  const children: ProjectTask[] = located.scan.tasks.filter((t) => t.parentId === located.task.id);
  const expected = located.task.childIds?.length ?? 0;
  if (expected > children.length) {
    rt.out.warn(`${expected - children.length} subtask(s) are not open (completed, abandoned, or deleted) and are not listed.`);
  }
  const views = children.map((t) => toTaskView(t, t.projectName, "open", tz));
  rt.out.success(views, () => (views.length ? views.map(taskLine).join("\n") : "No open subtasks."), rt.metaSources());
}

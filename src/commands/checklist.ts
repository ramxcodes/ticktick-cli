import { CliError } from "../errors";
import { isObjectId, locateOpenTask, locateTask, matchByName } from "../resolve";
import type { Runtime } from "../runtime";
import { formatApiDate, parseUserDate } from "../time";
import { ItemStatus, type ChecklistItem, type Task, type TaskWrite } from "../types";
import { emitDryRun } from "./task";

/**
 * Checklist items live in the task's `items` array; the API has no per-item endpoint.
 * Every write sends the full array read moments before (ids preserved, new items
 * without an id so the server assigns one), then verifies the result. Items changed
 * by someone else between that read and the write can still be overwritten; use
 * --if-etag to fail instead when the task changed after you looked at it.
 */

const itemLine = (i: ChecklistItem) => `${i.status === ItemStatus.Open ? "○" : "✓"} ${i.id}  ${i.title}`;

function findItem(task: Task, ref: string): ChecklistItem {
  const items = task.items ?? [];
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId;
  if (isObjectId(ref)) throw new CliError("NOT_FOUND", `Checklist item ${ref} is not on task ${task.id}.`);
  return matchByName(items, ref, (i) => i.title, (i) => `${i.id} ${i.title}`, "checklist item").item;
}

export async function checklistList(rt: Runtime, taskRef: string, opts: { project?: string }): Promise<void> {
  const api = await rt.api(true);
  const { task } = await locateTask(api, taskRef, opts);
  const items = task.items ?? [];
  rt.out.success({ taskId: task.id, items }, () => (items.length ? items.map(itemLine).join("\n") : "No checklist items."), rt.metaSources());
}

type Change =
  | { kind: "add"; title: string }
  | { kind: "status"; ref: string; status: number }
  | { kind: "delete"; ref: string };

export async function checklistChange(rt: Runtime, taskRef: string, change: Change, opts: { project?: string; ifEtag?: string; start?: string }): Promise<void> {
  if (change.kind === "add" && !change.title.trim()) throw new CliError("INVALID_ARGUMENT", "The item title must not be empty.");
  const api = await rt.api();
  const { task } = await locateOpenTask(api, taskRef, opts);
  if (opts.ifEtag !== undefined && task.etag !== opts.ifEtag) {
    throw new CliError("CONFLICT", `Task ${task.id} changed since it was read (etag ${task.etag ?? "none"}).`, { taskId: task.id, etag: task.etag });
  }
  const before = task.items ?? [];
  let items: TaskWrite["items"];
  let targetId: string | undefined;
  if (change.kind === "add") {
    let dated = {};
    if (opts.start) {
      const tz = await rt.timezone();
      dated = { startDate: formatApiDate(parseUserDate(opts.start, tz, rt.now).ms), timeZone: tz };
    }
    items = [...before, { title: change.title, ...dated }];
  } else {
    const item = findItem(task, change.ref);
    targetId = item.id;
    items = change.kind === "delete" ? before.filter((i) => i.id !== item.id) : before.map((i) => (i.id === item.id ? { ...i, status: change.status } : i));
  }
  const body: TaskWrite = { projectId: task.projectId, items };
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path: `/task/${task.id}`, body: { ...body, id: task.id } }]);

  const updated = await api.updateTask(task.id, body);
  const after = updated.items ?? [];
  const afterIds = new Set(after.map((i) => i.id));
  const lost = before.filter((i) => i.id !== targetId && !afterIds.has(i.id));
  let result: ChecklistItem | undefined;
  if (change.kind === "add") result = after.find((i) => !before.some((b) => b.id === i.id) && i.title === change.title);
  else if (change.kind === "status") result = after.find((i) => i.id === targetId && i.status === change.status);
  const ok = change.kind === "delete" ? !afterIds.has(targetId!) : Boolean(result);
  if (!ok || lost.length > 0) {
    throw new CliError("VERIFY_FAILED", `Checklist write on ${task.id} did not produce the expected items.`, { taskId: task.id, missingItems: lost.map((i) => i.id) });
  }
  const verb = { add: "Added", status: change.kind === "status" && change.status === ItemStatus.Completed ? "Completed" : "Reopened", delete: "Deleted" }[change.kind];
  rt.out.success(
    { taskId: task.id, etag: updated.etag, item: result ?? { id: targetId }, items: after },
    () => `✓ ${verb} ${result ? itemLine(result) : targetId}`,
    rt.metaSources(),
  );
}

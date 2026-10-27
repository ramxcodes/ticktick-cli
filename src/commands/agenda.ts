import { buildAgenda, type Agenda, type AgendaEntry, type AgendaInput } from "../agenda";
import { INBOX_ALIAS } from "../api";
import { resolveProject } from "../resolve";
import type { Runtime } from "../runtime";
import { fetchCompleted, listProjectsWithInbox, scanOpenTasks } from "../scan";
import { parseRange } from "../time";

export interface AgendaOptions {
  date?: string;
  from?: string;
  to?: string;
  days?: string;
  project?: string;
  includeCompleted?: boolean;
  includeClosed?: boolean;
  allowPartial?: boolean;
}

const MAX_RANGE_DAYS = 366;

function entryLine(e: AgendaEntry): string {
  const when =
    e.kind === "interval" ? `${e.start} → ${e.end}`
    : e.kind === "all-day" ? `${e.startDay}${e.endDay !== e.startDay ? ` → ${e.endDay}` : ""} all day`
    : `${e.kind === "deadline" ? "due " : "at "}${e.at}`;
  const occ = e.occurrence ? (e.occurrence.source === "calculated" ? " (calculated)" : " (series)") : "";
  return `${e.status === "completed" ? "✓" : e.blocksTime ? "■" : "·"} ${when}  ${e.title}  [${e.projectName}]${occ}  ${e.taskId}`;
}

function render(a: Agenda): string {
  const lines = [`Agenda ${a.range.start} → ${a.range.end}`];
  if (a.entries.length === 0) lines.push("  (nothing scheduled)");
  lines.push(...a.entries.map((e) => `  ${entryLine(e)}`));
  if (a.conflicts.length) lines.push("Conflicts:", ...a.conflicts.map((c) => `  ${c.a} ↔ ${c.b}  ${c.overlapStart} → ${c.overlapEnd}`));
  if (a.invalid.length) lines.push("Invalid dates:", ...a.invalid.map((i) => `  ${i.taskId} ${i.title}: ${i.reason}`));
  if (a.recurrence.unsupportedSeries.length) lines.push("Not expanded:", ...a.recurrence.unsupportedSeries.map((s) => `  ${s.taskId} ${s.title}: ${s.reason}`));
  lines.push(`${a.unscheduledCount} open task(s) have no date.`);
  return lines.join("\n");
}

/** `agenda`: calendar view of open tasks (and optionally completed ones) in a half-open range. */
export async function agendaCommand(rt: Runtime, opts: AgendaOptions): Promise<void> {
  const api = await rt.api(true);
  const [tz, projects] = await Promise.all([rt.timezone(), listProjectsWithInbox(api)]);
  const range = parseRange(opts, tz, rt.now);
  if (range.end - range.start > MAX_RANGE_DAYS * 86_400_000) {
    rt.out.warn(`Ranges longer than ${MAX_RANGE_DAYS} days are slow; consider a shorter window.`);
  }
  const scope = opts.project ? [resolveProject(projects, opts.project).project] : projects;
  const scan = await scanOpenTasks(api, { projects: scope, includeClosed: opts.includeClosed || Boolean(opts.project), allowPartial: opts.allowPartial });
  rt.out.setCoverage(scan.coverage);
  for (const f of scan.failures) rt.out.warn(`Project "${f.projectName}" (${f.projectId}) could not be read: ${f.code}.`);

  const inputs: AgendaInput[] = scan.tasks.map((t) => ({ task: t, projectName: t.projectName }));
  if (opts.includeCompleted) {
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const only = scope.length === 1 ? scope[0]! : undefined;
    const history = await fetchCompleted(api, range, only && only.id !== INBOX_ALIAS ? [only.id] : undefined);
    rt.out.setCoverage(history.coverage);
    history.warnings.forEach((w) => rt.out.warn(w));
    for (const t of history.tasks) {
      if (only?.id === INBOX_ALIAS && !t.projectId.startsWith("inbox")) continue;
      inputs.push({ task: t, projectName: names.get(t.projectId) ?? (t.projectId.startsWith("inbox") ? "Inbox" : t.projectId) });
    }
  }

  const agenda = buildAgenda(inputs, range.start, range.end, tz, (w) => rt.out.warn(w));
  if (agenda.recurrence.unsupportedSeries.length > 0) rt.out.setCoverage("unknown");
  rt.out.success(agenda, render, rt.metaSources());
}

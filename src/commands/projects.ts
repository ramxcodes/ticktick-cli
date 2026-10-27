import { INBOX_ALIAS } from "../api";
import { CliError } from "../errors";
import { resolveProject } from "../resolve";
import type { Runtime } from "../runtime";
import { listProjectsWithInbox } from "../scan";
import type { Project } from "../types";
import { emitDryRun } from "./task";

const VIEW_MODES = ["list", "kanban", "timeline"];

const projectLine = (p: Project) => `${p.id}  ${p.name}${p.closed ? "  [archived]" : ""}${p.kind && p.kind !== "TASK" ? `  (${p.kind.toLowerCase()})` : ""}`;

function normalizeColor(color: string): string {
  const hex = color.startsWith("#") ? color : `#${color}`;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new CliError("INVALID_ARGUMENT", `Invalid color "${color}". Use a hex value like #4772FA.`);
  return hex.toUpperCase();
}

function viewMode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!VIEW_MODES.includes(value)) throw new CliError("INVALID_ARGUMENT", `--view must be one of ${VIEW_MODES.join(", ")}.`);
  return value;
}

export async function projectsList(rt: Runtime, opts: { includeClosed?: boolean }): Promise<void> {
  const projects = (await listProjectsWithInbox(await rt.api(true))).filter((p) => opts.includeClosed || !p.closed);
  rt.out.success(projects, () => projects.map(projectLine).join("\n"), rt.metaSources());
}

export async function projectCreate(rt: Runtime, name: string, opts: { color?: string; view?: string; kind?: string }): Promise<void> {
  if (!name.trim()) throw new CliError("INVALID_ARGUMENT", "The project name must not be empty.");
  const kind = opts.kind === undefined ? undefined : ({ task: "TASK", note: "NOTE" } as Record<string, string>)[opts.kind];
  if (opts.kind !== undefined && !kind) throw new CliError("INVALID_ARGUMENT", "--kind must be task or note.");
  const body = { name, ...(opts.color ? { color: normalizeColor(opts.color) } : {}), ...(opts.view ? { viewMode: viewMode(opts.view) } : {}), ...(kind ? { kind } : {}) };
  const api = await rt.api();
  const existing = (await api.listProjects()).filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing.length > 0) rt.out.warn(`A project named "${name}" already exists (${existing.map((p) => p.id).join(", ")}).`);
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path: "/project", body }]);
  const project = await api.createProject(body);
  if (project.name !== name) throw new CliError("VERIFY_FAILED", `Project ${project.id} was created with name "${project.name}".`, { project });
  rt.out.success(project, (p) => `✓ Created ${projectLine(p)}`, rt.metaSources());
}

export async function projectUpdate(rt: Runtime, ref: string, opts: { name?: string; color?: string; view?: string }): Promise<void> {
  const body = { ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.color ? { color: normalizeColor(opts.color) } : {}), ...(opts.view ? { viewMode: viewMode(opts.view) } : {}) };
  if (Object.keys(body).length === 0) throw new CliError("INVALID_ARGUMENT", "Nothing to update. Pass --name, --color, or --view.");
  if (opts.name !== undefined && !opts.name.trim()) throw new CliError("INVALID_ARGUMENT", "--name must not be empty.");
  const api = await rt.api();
  const { project } = resolveProject(await listProjectsWithInbox(api), ref);
  if (project.id === INBOX_ALIAS) throw new CliError("UNSUPPORTED_CAPABILITY", "The Inbox cannot be renamed or recoloured through the API.");
  if (rt.dryRun) return emitDryRun(rt, [{ method: "POST", path: `/project/${project.id}`, body }]);
  const updated = await api.updateProject(project.id, body);
  const wrong = Object.entries(body).filter(([k, v]) => String(updated[k as keyof Project] ?? "").toLowerCase() !== String(v).toLowerCase());
  if (wrong.length > 0) throw new CliError("VERIFY_FAILED", `Project ${project.id} was updated, but these fields differ: ${wrong.map(([k]) => k).join(", ")}.`, { project: updated });
  rt.out.success(updated, (p) => `✓ Updated ${projectLine(p)}`, rt.metaSources());
}

export async function projectColumns(rt: Runtime, ref: string): Promise<void> {
  const api = await rt.api(true);
  const { project } = resolveProject(await listProjectsWithInbox(api), ref);
  const columns = await api.listColumns(project.id === INBOX_ALIAS ? "inbox" : project.id);
  const sorted = [...columns].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
  rt.out.success(sorted, () => (sorted.length ? sorted.map((c) => `${c.id}  ${c.name}`).join("\n") : `No columns in ${project.name} (only kanban projects have columns).`), rt.metaSources());
}

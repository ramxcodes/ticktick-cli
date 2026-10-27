#!/usr/bin/env bun
import { Command, CommanderError, Option } from "commander";
import { CliError, toCliError } from "./errors";
import { Output } from "./output";
import { Runtime, type GlobalOptions } from "./runtime";
import { agendaCommand } from "./commands/agenda";
import { authLogin, authLogout, authStatus, authToken } from "./commands/auth";
import { checklistChange, checklistList } from "./commands/checklist";
import { configSet, configShow, configUnset, doctor, opsList, opsResolve, opsShow } from "./commands/admin";
import { projectColumns, projectCreate, projectsList, projectUpdate } from "./commands/projects";
import { collect } from "./commands/shared";
import { taskAbandon, taskComplete, taskCreate, taskDelete, taskGet, taskMove, taskSubtasks, taskUpdate } from "./commands/task";
import { tasksAbandoned, tasksBatch, tasksCompleted, tasksList } from "./commands/tasks";
import { ItemStatus } from "./types";
import pkg from "../package.json";

/**
 * Wraps a command handler: builds the Runtime from global flags, prints exactly one
 * result or error envelope, and sets the exit code. Handlers receive positional
 * arguments followed by their own options.
 */
function run<A extends unknown[]>(handler: (rt: Runtime, ...args: A) => Promise<void>) {
  return async (...raw: unknown[]) => {
    const command = raw[raw.length - 1] as Command;
    const options = command.optsWithGlobals<GlobalOptions & Record<string, unknown>>();
    const positional = raw.slice(0, -2);
    const rt = new Runtime(options);
    try {
      await handler(rt, ...([...positional, command.opts()] as A));
    } catch (error) {
      const e = toCliError(error);
      rt.out.failure(e, rt.metaSources());
      process.exitCode = e.exitCode;
    } finally {
      await rt.finish().catch(() => {});
      if (options.verbose) {
        const s = rt.metaSources().requests;
        if (s) process.stderr.write(`ticktick: ${s.count} request(s), ${s.retries} retr${s.retries === 1 ? "y" : "ies"}, ${s.writes} write(s)\n`);
      }
    }
  };
}

const range = (c: Command) =>
  c
    .option("--date <date>", "a single day (YYYY-MM-DD, today, tomorrow, ...)")
    .option("--from <date>", "range start (date or date-time)")
    .option("--to <date>", "range end; a date includes that whole day")
    .option("--days <n>", "number of days from --from (default 1)");

const program = new Command()
  .name("ticktick")
  .description("Reliable TickTick CLI for humans, scripts, and AI agents (official Open API).")
  .version(pkg.version, "-V, --version")
  .option("--json", "print one JSON envelope {ok, data|error, meta} on stdout")
  .option("--tz <zone>", "IANA timezone for input and output (default: config, account, machine)")
  .option("--dry-run", "show the write requests a command would send, send none")
  .option("--cache-ttl <seconds>", "read commands only: reuse GET responses younger than this")
  .option("-v, --verbose", "print request statistics to stderr")
  .showHelpAfterError()
  .exitOverride();

// tasks — account-wide queries and batch writes
const tasks = program.command("tasks").description("query many tasks, batch complete/abandon");
tasks
  .command("list")
  .description("open tasks across projects (complete scan, filtered locally)")
  .option("-p, --project <project>", "project id or name")
  .option("--priority <levels>", "comma list: none,low,medium,high")
  .option("--tag <tag>", "require tag (repeatable; all must match)", collect)
  .option("--search <text>", "case-insensitive text in title or content")
  .option("--kind <kinds>", "schedule kinds: interval,point,deadline,all-day,unscheduled,invalid")
  .option("--date <date>", "scheduled on this day")
  .option("--from <date>", "scheduled in range start")
  .option("--to <date>", "scheduled in range end (a date includes that day)")
  .option("--overdue", "due time (or all-day date) already passed")
  .option("--sort <field[:dir]>", "project|title|priority|start|due|created|modified (default project)")
  .option("--limit <n>", "show at most n tasks")
  .option("--fields <list>", "comma list of fields to output")
  .option("--include-closed", "include archived projects")
  .option("--allow-partial", "return data even if some projects fail (coverage: partial)")
  .action(run(tasksList));
range(tasks.command("completed").description("completed tasks by completion time (default: today)"))
  .option("-p, --project <project>", "project id or name")
  .option("--search <text>", "text in title or content")
  .option("--sort <field[:dir]>", "default completed:desc")
  .option("--limit <n>", "show at most n tasks")
  .option("--fields <list>", "comma list of fields to output")
  .action(run(tasksCompleted));
tasks
  .command("abandoned")
  .description("abandoned (won't do) tasks")
  .option("-p, --project <project>", "project id or name")
  .option("--search <text>", "text in title or content")
  .option("--sort <field[:dir]>", "default modified")
  .option("--limit <n>", "show at most n tasks")
  .option("--fields <list>", "comma list of fields to output")
  .action(run(tasksAbandoned));
tasks
  .command("complete <ids...>")
  .description("complete open tasks by id, with per-task results")
  .action(run((rt, ids: string[]) => tasksBatch(rt, "complete", ids)));
tasks
  .command("abandon <ids...>")
  .description("abandon open tasks by id, with per-task results")
  .action(run((rt, ids: string[]) => tasksBatch(rt, "abandon", ids)));

// task — one task
const task = program.command("task").description("read or change one task (id or unique title)");
task.command("get <task>").description("task details and lifecycle state").option("-p, --project <project>", "limit the search to one project").option("--fields <list>", "comma list of fields").action(run(taskGet));
const dates = (c: Command) =>
  c
    .option("--start <date>", "start (date-time, or date for all-day)")
    .option("--due <date>", "due / end (date-time, or date for all-day)")
    .addOption(new Option("--all-day", "force an all-day task"))
    .addOption(new Option("--no-all-day", "force a timed task"))
    .option("--priority <level>", "none|low|medium|high")
    .option("--content <text>", "notes / description")
    .option("--reminder <offset>", "at|15m|2h|1d or TRIGGER:... (repeatable)", collect)
    .option("--repeat <rrule>", "e.g. FREQ=WEEKLY;BYDAY=MO (none to remove on update)")
    .option("--column <columnId>", "kanban column id");
dates(task.command("create <title>").description("create a task"))
  .option("-p, --project <project>", "project id or name (required unless --parent)")
  .option("--parent <task>", "make it a subtask of this open task")
  .option("--tag <tag>", "tag (repeatable)", collect)
  .option("--item <title>", "checklist item (repeatable)", collect)
  .option("--kind <kind>", "text|note")
  .option("--op-id <id>", "idempotency key: the same id never creates twice")
  .action(run(taskCreate));
dates(task.command("update <task>").description("change only the given fields"))
  .option("-p, --project <project>", "limit the search to one project")
  .option("--title <title>", "new title")
  .option("--clear-start", "remove the start date")
  .option("--clear-due", "remove the due date")
  .option("--tag <tag>", "replace all tags (repeatable)", collect)
  .option("--add-tag <tag>", "add a tag (repeatable)", collect)
  .option("--remove-tag <tag>", "remove a tag (repeatable)", collect)
  .option("--clear-reminders", "remove all reminders")
  .option("--if-etag <etag>", "fail with CONFLICT if the task changed")
  .action(run(taskUpdate));
task.command("complete <task>").description("complete a task (one occurrence for recurring tasks)").option("-p, --project <project>", "limit the search to one project").option("--if-etag <etag>", "fail with CONFLICT if the task changed").option("--op-id <id>", "idempotency key: the same id never completes twice").action(run(taskComplete));
task.command("abandon <task>").description("mark as won't do").option("-p, --project <project>", "limit the search to one project").option("--if-etag <etag>", "fail with CONFLICT if the task changed").action(run(taskAbandon));
task.command("delete <id>").description("delete a task (id only)").option("-y, --yes", "confirm without a prompt").option("--if-etag <etag>", "fail with CONFLICT if the task changed").action(run(taskDelete));
task.command("move <task>").description("move to another project and/or kanban column").option("-p, --project <project>", "limit the search to one project").option("--to <project>", "target project id or name").option("--column <columnId>", "target column id").option("--if-etag <etag>", "fail with CONFLICT if the task changed").action(run(taskMove));
task.command("subtasks <task>").description("open subtasks of a task").option("-p, --project <project>", "limit the search to one project").action(run(taskSubtasks));

// checklist — items inside one task
const checklist = program.command("checklist").description("checklist items of a task");
const itemOpts = (c: Command) => c.option("-p, --project <project>", "limit the task search to one project").option("--if-etag <etag>", "fail with CONFLICT if the task changed");
checklist.command("list <task>").description("list items").option("-p, --project <project>", "limit the task search to one project").action(run(checklistList));
itemOpts(checklist.command("add <task> <title>").description("add an item"))
  .option("--start <date>", "item date")
  .action(run((rt, t: string, title: string, o: { project?: string; ifEtag?: string; start?: string }) => checklistChange(rt, t, { kind: "add", title }, o)));
itemOpts(checklist.command("complete <task> <item>").description("complete an item (id or title)")).action(run((rt, t: string, item: string, o: { project?: string; ifEtag?: string }) => checklistChange(rt, t, { kind: "status", ref: item, status: ItemStatus.Completed }, o)));
itemOpts(checklist.command("reopen <task> <item>").description("mark an item not done")).action(run((rt, t: string, item: string, o: { project?: string; ifEtag?: string }) => checklistChange(rt, t, { kind: "status", ref: item, status: ItemStatus.Open }, o)));
itemOpts(checklist.command("delete <task> <item>").description("delete an item")).action(run((rt, t: string, item: string, o: { project?: string; ifEtag?: string }) => checklistChange(rt, t, { kind: "delete", ref: item }, o)));

// agenda
range(program.command("agenda").description("calendar view: intervals, points, deadlines, all-day, recurrence (default: today)"))
  .option("-p, --project <project>", "project id or name")
  .option("--include-completed", "add completed tasks from completion history")
  .option("--include-closed", "include archived projects")
  .option("--allow-partial", "return data even if some projects fail (coverage: partial)")
  .action(run(agendaCommand));

// projects
const projects = program.command("projects").description("projects (lists)");
projects.command("list").description("all projects, plus the Inbox").option("--include-closed", "include archived projects").action(run(projectsList));
projects.command("create <name>").description("create a project").option("--color <hex>", "e.g. #4772FA").option("--view <mode>", "list|kanban|timeline").option("--kind <kind>", "task|note").action(run(projectCreate));
projects.command("update <project>").description("rename or restyle a project").option("--name <name>", "new name").option("--color <hex>", "e.g. #4772FA").option("--view <mode>", "list|kanban|timeline").action(run(projectUpdate));
projects.command("columns <project>").description("kanban columns of a project").action(run(projectColumns));

// auth
const auth = program.command("auth").description("credentials");
auth.command("token").description("save a personal API token read from stdin").action(run(authToken));
auth
  .command("login")
  .description("OAuth login (browser, or --manual for headless machines)")
  .option("--client-id <id>", "OAuth client id (or TICKTICK_CLIENT_ID)")
  .option("--client-secret <secret>", "OAuth client secret (or TICKTICK_CLIENT_SECRET)")
  .option("--redirect-uri <uri>", "registered redirect URI (default http://localhost:8080)")
  .option("--manual", "print the URL and paste the redirect URL back")
  .action(run(authLogin));
auth.command("status").description("where credentials come from and whether TickTick accepts them").action(run(authStatus));
auth.command("logout").description("remove the saved token").option("--revoke", "also revoke it at TickTick").action(run(authLogout));

// config
const config = program.command("config").description("CLI settings");
config.command("show").description("show settings").action(run(configShow));
config.command("set <key> <value>").description("set a setting (timezone)").action(run(configSet));
config.command("unset <key>").description("remove a setting").action(run(configUnset));

// ops — idempotency ledger
const ops = program.command("ops").description("operations recorded with --op-id");
ops.command("list").description("recorded operations (30-day retention)").action(run(opsList));
ops.command("show <opId>").description("one operation, with candidates for uncertain creates").action(run(opsShow));
ops.command("resolve <opId>").description("settle an uncertain operation").option("--task <id>", "the task the operation produced").option("--not-applied", "the write did not happen; the op id may run again").action(run(opsResolve));

program.command("doctor").description("check configuration, credentials, connectivity, and API capabilities").action(run(doctor));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.code === "commander.help") process.exit(0);
    const json = process.argv.includes("--json");
    const e = new CliError("INVALID_ARGUMENT", error.message.replace(/^error: /, ""));
    if (json) new Output(true).failure(e, { usedApi: false });
    process.exit(e.exitCode);
  }
  const e = toCliError(error);
  new Output(process.argv.includes("--json")).failure(e, { usedApi: false });
  process.exit(e.exitCode);
}

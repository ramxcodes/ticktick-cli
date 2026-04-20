#!/usr/bin/env bun

import { Command } from "commander";
import {
  authenticate,
  authenticateManual,
  checkAuth,
  logout,
  setupCredentials,
} from "./auth";
import { tasksCommand } from "./commands/tasks";
import { taskCreateCommand, taskUpdateCommand } from "./commands/task";
import { completeCommand } from "./commands/complete";
import { abandonCommand } from "./commands/abandon";
import { batchAbandonCommand } from "./commands/batch-abandon";
import { listsCommand } from "./commands/lists";
import { listCreateCommand, listUpdateCommand } from "./commands/list";
import {
  checklistListCommand,
  checklistAddCommand,
  checklistCompleteCommand,
  checklistDeleteCommand,
} from "./commands/checklist";
import { moveCommand } from "./commands/move";
import { columnsCommand } from "./commands/columns";
import { getTaskCommand } from "./commands/get-task";

const program = new Command();

program
  .name("ticktick")
  .description("CLI for TickTick task and project management")
  .version("0.1.0");

// Auth command
const authCmd = program
  .command("auth")
  .description("Authenticate with TickTick");

authCmd
  .option("--client-id <id>", "TickTick OAuth client ID")
  .option("--client-secret <secret>", "TickTick OAuth client secret")
  .option("--manual", "Manual auth flow for headless servers (paste redirect URL)")
  .option("--logout", "Clear authentication tokens")
  .option("--status", "Check authentication status")
  .action(async (options) => {
    if (options.status) {
      const isAuthed = await checkAuth();
      if (isAuthed) {
        console.log("✓ Authenticated with TickTick");
      } else {
        console.log("✗ Not authenticated. Run 'ticktick auth' to set up.");
      }
      return;
    }

    if (options.logout) {
      await logout();
      return;
    }

    if (options.clientId && options.clientSecret) {
      await setupCredentials(options.clientId, options.clientSecret);
    }

    // Start OAuth flow
    if (options.manual) {
      await authenticateManual();
    } else {
      await authenticate();
    }
  });

// Complete command - mark task as done
program
  .command("complete <task>")
  .description("Mark a task as complete")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("--json", "Output as JSON")
  .action(completeCommand);

// Abandon command - mark task as won't do
program
  .command("abandon <task>")
  .description("Mark a task as won't do")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("--json", "Output as JSON")
  .action(abandonCommand);

// Batch abandon command - abandon multiple tasks at once
program
  .command("batch-abandon <taskIds...>")
  .description("Abandon multiple tasks in a single API call")
  .option("--json", "Output as JSON")
  .action(batchAbandonCommand);

// Tasks command - list tasks with date filtering
program
  .command("tasks")
  .description("List tasks")
  .option("-l, --list <name>", "Filter by project name or ID")
  .option(
    "-s, --status <status>",
    "Filter by status: pending or completed"
  )
  .option(
    "-d, --date <date>",
    "Filter by date: today, tomorrow, this week, next week, overdue, or YYYY-MM-DD"
  )
  .option("--json", "Output as JSON")
  .action(tasksCommand);

// Get-task command - fetch one task by id or title
program
  .command("get-task <task>")
  .description("Get a single task with full details")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("--json", "Output as JSON")
  .action(getTaskCommand);

// Task command - create or update task with reminders and all-day support
program
  .command("task <title>")
  .description("Create or update a task or note")
  .option("-l, --list <name>", "Project name or ID (required for create)")
  .option("-c, --content <description>", "Task description/content")
  .option(
    "-p, --priority <level>",
    "Priority: none, low, medium, high"
  )
  .option(
    "-d, --due <date>",
    "Due date: today, tomorrow, 'in N days', or ISO date"
  )
  .option("--from <date>", "Start time for time block (sets startDate)")
  .option("--to <date>", "End time for time block (sets dueDate)")
  .option("-t, --tag <tags...>", "Tags for the task")
  .option("-r, --reminder <times...>", "Reminders: 30m, 2h, 9:00, tomorrow 9am, or ISO date")
  .option("--column <columnId>", "Kanban column ID to place the task in")
  .option("--all-day", "Mark as all-day task")
  .option("--note", "Create as a note instead of a task (no due date, priority, or reminders)")
  .option("-u, --update", "Update existing task instead of creating")
  .option("--json", "Output as JSON")
  .action(async (title, options) => {
    if (options.update) {
      await taskUpdateCommand(title, options);
    } else {
      if (!options.list) {
        console.error("Error: --list is required when creating a task");
        process.exit(1);
      }
      await taskCreateCommand(title, options);
    }
  });

// Move command - move task to different project
program
  .command("move <task>")
  .description("Move a task to a different project")
  .option("-l, --from <name>", "Source project name or ID (optional)")
  .option("-t, --to <name>", "Target project name or ID")
  .option("--column <columnId>", "Target Kanban column ID (moves within same project)")
  .option("--json", "Output as JSON")
  .action(moveCommand);

// Checklist commands
const checklistCmd = program
  .command("checklist")
  .description("Manage checklist items on tasks");

checklistCmd
  .command("list <task>")
  .description("List checklist items for a task")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("--json", "Output as JSON")
  .action(checklistListCommand);

checklistCmd
  .command("add <task> <item>")
  .description("Add a checklist item to a task")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("-d, --due <date>", "Due date for the checklist item")
  .option("--json", "Output as JSON")
  .action(checklistAddCommand);

checklistCmd
  .command("complete <task> <item>")
  .description("Mark a checklist item as complete (use item title or ID)")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("--json", "Output as JSON")
  .action(checklistCompleteCommand);

checklistCmd
  .command("delete <task> <item>")
  .description("Delete a checklist item (use item title or ID)")
  .option("-l, --list <name>", "Project name or ID to search in")
  .option("--json", "Output as JSON")
  .action(checklistDeleteCommand);

// Lists command - list all projects
program
  .command("lists")
  .description("List all projects")
  .option("--json", "Output as JSON")
  .action(listsCommand);

// Columns command - list Kanban columns in a project
program
  .command('columns <project>')
  .description('List Kanban columns in a project')
  .option('--json', 'Output as JSON')
  .action(columnsCommand);

// List command - create or update project
program
  .command("list <name>")
  .description("Create or update a project")
  .option("-c, --color <hex>", "Project color in hex format")
  .option("-u, --update", "Update existing project instead of creating")
  .option("-n, --name <newName>", "New name (for update)")
  .option("--json", "Output as JSON")
  .action(async (name, options) => {
    if (options.update) {
      await listUpdateCommand(name, options);
    } else {
      await listCreateCommand(name, options);
    }
  });

program.parse();

import { api, type ChecklistItem } from "../api";

interface ChecklistOptions {
  list?: string;
  json?: boolean;
}

interface ChecklistAddOptions {
  list?: string;
  due?: string;
  json?: boolean;
}

interface ChecklistCompleteOptions {
  list?: string;
  json?: boolean;
}

// Check if string looks like a task ID (24-char hex)
function isTaskId(str: string): boolean {
  return /^[a-f0-9]{24}$/i.test(str);
}

function formatChecklistItem(item: ChecklistItem): string {
  const status = item.status === 2 ? "✓" : "○";
  return `${status} [${item.id.slice(0, 8)}] ${item.title}`;
}

export async function checklistListCommand(
  taskNameOrId: string,
  options: ChecklistOptions
): Promise<void> {
  try {
    let found: { task: { id: string; title: string; items?: ChecklistItem[] }; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(taskNameOrId) && !options.list) {
      const result = await api.findTaskById(taskNameOrId);
      if (result) {
        found = { task: result.task, projectId: result.projectId };
      }
    } else {
      // Search by title (with optional project filter)
      const result = await api.findTaskByTitle(taskNameOrId, options.list);
      if (result) {
        found = { task: result.task, projectId: result.projectId };
      }
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId } = found;

    // Fetch checklist items
    const items = await api.getChecklistItems(projectId, task.id);

    if (options.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log(`No checklist items for task: "${task.title}"`);
      return;
    }

    console.log(`\nChecklist items for "${task.title}" (${items.length}):\n`);
    for (const item of items) {
      console.log(formatChecklistItem(item));
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export async function checklistAddCommand(
  taskNameOrId: string,
  itemTitle: string,
  options: ChecklistAddOptions
): Promise<void> {
  try {
    let found: { task: { id: string; title: string }; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(taskNameOrId) && !options.list) {
      found = await api.findTaskById(taskNameOrId);
    } else {
      // Search by title (with optional project filter)
      found = await api.findTaskByTitle(taskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId } = found;

    const input: { title: string; startDate?: string; isAllDay?: boolean; timeZone?: string } = {
      title: itemTitle,
    };

    if (options.due) {
      // For checklist items, due date goes in startDate
      const date = new Date(options.due);
      if (!isNaN(date.getTime())) {
        input.startDate = date.toISOString().replace("Z", "+0000");
      }
    }

    const item = await api.createChecklistItem(projectId, task.id, input);

    if (options.json) {
      console.log(JSON.stringify(item, null, 2));
      return;
    }

    console.log(`✓ Checklist item added to "${task.title}"`);
    console.log(`  ID: ${item.id}`);
    console.log(`  Title: ${item.title}`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export async function checklistCompleteCommand(
  taskNameOrId: string,
  itemIdOrTitle: string,
  options: ChecklistCompleteOptions
): Promise<void> {
  try {
    let found: { task: { id: string; title: string }; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(taskNameOrId) && !options.list) {
      found = await api.findTaskById(taskNameOrId);
    } else {
      // Search by title (with optional project filter)
      found = await api.findTaskByTitle(taskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId } = found;

    // Get checklist items to find the one to complete
    const items = await api.getChecklistItems(projectId, task.id);

    let itemId = itemIdOrTitle;

    // If not an ID (not 24 hex chars), search by title
    if (!isTaskId(itemIdOrTitle)) {
      const matchingItem = items.find(
        (i) => i.title.toLowerCase() === itemIdOrTitle.toLowerCase()
      );
      if (!matchingItem) {
        console.error(`Checklist item not found: "${itemIdOrTitle}"`);
        process.exit(1);
      }
      itemId = matchingItem.id;
    }

    const item = await api.completeChecklistItem(projectId, task.id, itemId);

    if (options.json) {
      console.log(JSON.stringify(item, null, 2));
      return;
    }

    console.log(`✓ Checklist item completed: "${item.title}"`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export async function checklistDeleteCommand(
  taskNameOrId: string,
  itemIdOrTitle: string,
  options: ChecklistOptions
): Promise<void> {
  try {
    let found: { task: { id: string; title: string }; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(taskNameOrId) && !options.list) {
      found = await api.findTaskById(taskNameOrId);
    } else {
      // Search by title (with optional project filter)
      found = await api.findTaskByTitle(taskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId } = found;

    // Get checklist items to find the one to delete
    const items = await api.getChecklistItems(projectId, task.id);

    let itemId = itemIdOrTitle;

    // If not an ID (not 24 hex chars), search by title
    if (!isTaskId(itemIdOrTitle)) {
      const matchingItem = items.find(
        (i) => i.title.toLowerCase() === itemIdOrTitle.toLowerCase()
      );
      if (!matchingItem) {
        console.error(`Checklist item not found: "${itemIdOrTitle}"`);
        process.exit(1);
      }
      itemId = matchingItem.id;
    }

    await api.deleteChecklistItem(projectId, task.id, itemId);

    if (options.json) {
      console.log(JSON.stringify({ deleted: itemId }, null, 2));
      return;
    }

    console.log(`✓ Checklist item deleted from "${task.title}"`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

import { api, type Task, type CreateTaskInput, PRIORITY_MAP } from "../api";

interface SubtaskOptions {
  list?: string;
  json?: boolean;
}

interface SubtaskAddOptions {
  list?: string;
  content?: string;
  priority?: string;
  due?: string;
  tag?: string[];
  column?: string;
  json?: boolean;
}

interface SubtaskCompleteOptions {
  list?: string;
  json?: boolean;
}

// Check if string looks like a task ID (24-char hex)
function isTaskId(str: string): boolean {
  return /^[a-f0-9]{24}$/i.test(str);
}

function formatSubTask(task: Task): string {
  const status = task.status === 2 ? "done" : task.status === -1 ? "cancelled" : "pending";
  return status + " [" + task.id.slice(0, 8) + "] " + task.title;
}

export async function subtaskListCommand(
  parentTaskNameOrId: string,
  options: SubtaskOptions
): Promise<void> {
  try {
    let found: { task: Task; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(parentTaskNameOrId) && !options.list) {
      found = await api.findTaskById(parentTaskNameOrId);
    } else {
      found = await api.findTaskByTitle(parentTaskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${parentTaskNameOrId}`);
      process.exit(1);
    }

    const { task: parent, projectId } = found;

    const data = await api.getProjectData(projectId);
    const subtasks = (data.tasks || []).filter((t) => t.parentId === parent.id);

    if (options.json) {
      console.log(JSON.stringify(subtasks, null, 2));
      return;
    }

    if (subtasks.length === 0) {
      console.log(`No sub-tasks for task: "${parent.title}"`);
      return;
    }

    console.log(`\nSub-tasks of "${parent.title}" (${subtasks.length}):\n`);
    for (const subtask of subtasks) {
      console.log(formatSubTask(subtask));
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export async function subtaskAddCommand(
  parentTaskNameOrId: string,
  title: string,
  options: SubtaskAddOptions
): Promise<void> {
  try {
    let found: { task: Task; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(parentTaskNameOrId) && !options.list) {
      found = await api.findTaskById(parentTaskNameOrId);
    } else {
      found = await api.findTaskByTitle(parentTaskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${parentTaskNameOrId}`);
      process.exit(1);
    }

    const { task: parent } = found;

    const input: CreateTaskInput = {
      title,
      projectId: parent.projectId,
      parentId: parent.id,
    };

    if (options.content) {
      input.content = options.content;
    }

    if (options.priority) {
      const priorityVal = PRIORITY_MAP[options.priority.toLowerCase()];
      if (priorityVal !== undefined) {
        input.priority = priorityVal;
      }
    }

    if (options.due) {
      const date = new Date(options.due);
      if (!isNaN(date.getTime())) {
        input.dueDate = date.toISOString().replace("Z", "+0000");
      }
    }

    if (options.tag) {
      input.tags = options.tag;
    }

    if (options.column) {
      input.columnId = options.column;
    }

    const task = await api.createTask(input);

    if (options.json) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    console.log(`✓ Sub-task added to "${parent.title}"`);
    console.log(`  ID: ${task.id}`);
    console.log(`  Title: ${task.title}`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export async function subtaskCompleteCommand(
  parentTaskNameOrId: string,
  subtaskNameOrId: string,
  options: SubtaskCompleteOptions
): Promise<void> {
  try {
    let found: { task: Task; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(parentTaskNameOrId) && !options.list) {
      found = await api.findTaskById(parentTaskNameOrId);
    } else {
      found = await api.findTaskByTitle(parentTaskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${parentTaskNameOrId}`);
      process.exit(1);
    }

    const { task: parent, projectId } = found;

    const data = await api.getProjectData(projectId);
    const subtasks = (data.tasks || []).filter((t) => t.parentId === parent.id);

    let subtask: Task | undefined;

    if (isTaskId(subtaskNameOrId)) {
      subtask = subtasks.find((t) => t.id === subtaskNameOrId);
    } else {
      subtask = subtasks.find(
        (t) => t.title.toLowerCase() === subtaskNameOrId.toLowerCase()
      );
    }

    if (!subtask) {
      console.error(`Sub-task not found: "${subtaskNameOrId}"`);
      process.exit(1);
    }

    const updated = await api.updateTask({
      id: subtask.id,
      projectId: parent.projectId,
      status: 2,
    });

    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    console.log(`✓ Sub-task completed: "${updated.title}"`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

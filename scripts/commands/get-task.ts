import { api, type Task } from "../api";

interface GetTaskOptions {
  list?: string;
  json?: boolean;
}

// Check if string looks like a task ID (24-char hex)
function isTaskId(str: string): boolean {
  return /^[a-f0-9]{24}$/i.test(str);
}

export async function getTaskCommand(taskNameOrId: string, options: GetTaskOptions): Promise<void> {
  try {
    let found: { task: Task; projectId: string } | undefined;

    if (isTaskId(taskNameOrId) && !options.list) {
      found = await api.findTaskById(taskNameOrId);
    } else {
      found = await api.findTaskByTitle(taskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId } = found;
    const projects = await api.listProjects();
    const project = projects.find((p) => p.id === projectId);

    if (options.json) {
      console.log(JSON.stringify({ ...task, projectName: project?.name || projectId }, null, 2));
      return;
    }

    console.log(`Task: ${task.title}`);
    console.log(`ID: ${task.id}`);
    console.log(`Project: ${project?.name || projectId}`);
    console.log(`Status: ${task.status === 2 ? "completed" : task.status === -1 ? "abandoned" : "pending"}`);
    console.log(`Priority: ${task.priority}`);
    if (task.dueDate) {
      console.log(`Due: ${task.dueDate}`);
    }
    if (task.startDate) {
      console.log(`Start: ${task.startDate}`);
    }
    if (task.tags && task.tags.length > 0) {
      console.log(`Tags: ${task.tags.join(", ")}`);
    }
    if (task.reminders && task.reminders.length > 0) {
      console.log(`Reminders: ${task.reminders.join(", ")}`);
    }
    console.log("Content:");
    console.log(task.content ?? "");
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

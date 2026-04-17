import { api, type Task } from "../api";

interface GetTaskOptions {
  list?: string;
  json?: boolean;
}

// Check if string looks like a task ID (24-char hex)
function isTaskId(str: string): boolean {
  return /^[a-f0-9]{24}$/i.test(str);
}

/**
 * Describe a TRIGGER duration string in human-readable form for get-task display.
 * Duplicated from task.ts to avoid cross-file imports for a small utility.
 */
function describeTriggerForGetTask(trigger: string): string | null {
  const match = trigger.match(/^TRIGGER:([+-]?)P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S$/);
  if (!match) return null;

  const sign = match[1] === "-" ? -1 : 1;
  const years = parseInt(match[2] || "0", 10);
  const months = parseInt(match[3] || "0", 10);
  const days = parseInt(match[4] || "0", 10);
  const hours = parseInt(match[5] || "0", 10);
  const minutes = parseInt(match[6] || "0", 10);
  const seconds = parseFloat(match[7] || "0");

  const totalMs = sign * (
    (years * 365.25 * 24 * 60 * 60 * 1000) +
    (months * 30.44 * 24 * 60 * 60 * 1000) +
    (days * 24 * 60 * 60 * 1000) +
    (hours * 60 * 60 * 1000) +
    (minutes * 60 * 1000) +
    (seconds * 1000)
  );

  const absMs = Math.abs(totalMs);
  const isBefore = totalMs < 0;

  if (absMs === 0) return "At task time";

  const totalMinutes = Math.round(absMs / (60 * 1000));
  const totalHours = Math.round(absMs / (60 * 60 * 1000));
  const totalDays = Math.round(absMs / (24 * 60 * 60 * 1000));

  let desc: string;
  if (totalMinutes < 60) {
    desc = `${totalMinutes} minute${totalMinutes !== 1 ? "s" : ""}`;
  } else if (totalHours < 24) {
    desc = `${totalHours} hour${totalHours !== 1 ? "s" : ""}`;
  } else {
    desc = `${totalDays} day${totalDays !== 1 ? "s" : ""}`;
  }

  return isBefore ? `${desc} before task time` : `${desc} after task time`;
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
      const reminderLabels = task.reminders.map(r => {
        if (r.startsWith("TRIGGER:")) {
          // Show human-readable trigger description
          const description = describeTriggerForGetTask(r);
          return description || r;
        }
        return r;
      });
      console.log(`Reminders: ${reminderLabels.join(", ")}`);
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

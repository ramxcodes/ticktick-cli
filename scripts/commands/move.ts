import { api } from "../api";

interface MoveOptions {
  from?: string;
  to: string;
  json?: boolean;
}

// Check if string looks like a task ID (24-char hex)
function isTaskId(str: string): boolean {
  return /^[a-f0-9]{24}$/i.test(str);
}

export async function moveCommand(
  taskNameOrId: string,
  options: MoveOptions
): Promise<void> {
  try {
    if (!options.to) {
      console.error("Error: --to <project> is required");
      process.exit(1);
    }

    let found: { task: { id: string; title: string }; projectId: string } | undefined;

    // If it looks like an ID and no --from specified, use findTaskById
    if (isTaskId(taskNameOrId) && !options.from) {
      found = await api.findTaskById(taskNameOrId);
    } else {
      // Search by title (with optional project filter)
      found = await api.findTaskByTitle(taskNameOrId, options.from);
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId: fromProjectId } = found;

    // Find the target project
    const targetProject = await api.findProjectByName(options.to);
    if (!targetProject) {
      console.error(`Target project not found: ${options.to}`);
      process.exit(1);
    }

    if (fromProjectId === targetProject.id) {
      console.log(`Task "${task.title}" is already in project "${targetProject.name}"`);
      return;
    }

    // Move the task
    const movedTask = await api.moveTask(task.id, fromProjectId, targetProject.id);

    if (options.json) {
      console.log(JSON.stringify(movedTask, null, 2));
      return;
    }

    console.log(`✓ Task moved: "${task.title}"`);
    console.log(`  From: ${options.from || fromProjectId}`);
    console.log(`  To: ${targetProject.name}`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

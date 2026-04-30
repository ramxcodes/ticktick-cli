import { api, PRIORITY_REVERSE, type Task } from "../api";

interface TaskWithProject extends Task {
  projectName?: string;
}

interface TasksOptions {
  list?: string;
  status?: "pending" | "completed";
  date?: string;
  grep?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  sort?: string;
}

function parseDateFilter(dateStr: string): { start: Date; end: Date } | null {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = new Date(now);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const lowerDate = dateStr.toLowerCase();

  if (lowerDate === "today") {
    return { start, end };
  }

  if (lowerDate === "tomorrow") {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  if (lowerDate === "yesterday") {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
    return { start, end };
  }

  if (lowerDate === "this week") {
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust for Monday start
    start.setDate(diff);
    end.setDate(start.getDate() + 6);
    return { start, end };
  }

  if (lowerDate === "next week") {
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1) + 7;
    start.setDate(diff);
    end.setDate(start.getDate() + 6);
    return { start, end };
  }

  if (lowerDate === "overdue") {
    end.setDate(now.getDate() - 1);
    return { start: new Date(0), end };
  }

  // Try parsing as a specific date (YYYY-MM-DD)
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    parsed.setHours(0, 0, 0, 0);
    const endDate = new Date(parsed);
    endDate.setHours(23, 59, 59, 999);
    return { start: parsed, end: endDate };
  }

  return null;
}

function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Check if it's today or tomorrow
  if (date.toDateString() === now.toDateString()) {
    return "today";
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return "tomorrow";
  }

  // Format as "Jan 7" style
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTask(task: TaskWithProject, showProject = false): string {
  const status = task.status === 2 ? "✓" : "○";
  const priorityIndicator =
    task.priority === 5
      ? "!!!"
      : task.priority === 3
        ? "!!"
        : task.priority === 1
          ? "!"
          : "";
  const dueStr = task.dueDate ? ` - due ${formatDueDate(task.dueDate)}` : "";
  const projectStr = showProject && task.projectName ? ` (${task.projectName})` : "";
  const shortId = task.id.slice(0, 8);

  return `${status} [${shortId}] ${priorityIndicator}${task.title}${projectStr}${dueStr}`;
}

export async function tasksCommand(options: TasksOptions): Promise<void> {
  try {
    const projects = await api.listProjects();
    const projectMap = new Map(projects.map((p) => [p.id, p.name]));

    let searchProjects = projects;
    if (options.list) {
      const project = await api.findProjectByName(options.list);
      if (!project) {
        console.error(`Project not found: ${options.list}`);
        process.exit(1);
      }
      searchProjects = [project];
    }

    const tasksWithProjects: TaskWithProject[] = [];
    for (const project of searchProjects) {
      try {
        const data = await api.getProjectData(project.id);
        if (data.tasks) {
          for (const task of data.tasks) {
            tasksWithProjects.push({
              ...task,
              projectName: projectMap.get(task.projectId) || task.projectId,
            });
          }
        }
      } catch {
        continue;
      }
    }

    // Filter by status if specified
    let filteredTasks = tasksWithProjects;
    if (options.status === "pending") {
      filteredTasks = tasksWithProjects.filter((t) => t.status !== 2);
    } else if (options.status === "completed") {
      filteredTasks = tasksWithProjects.filter((t) => t.status === 2);
    }

    // Filter by date if specified
    if (options.date) {
      const dateRange = parseDateFilter(options.date);
      if (!dateRange) {
        console.error(`Invalid date filter: ${options.date}`);
        console.error("Valid options: today, tomorrow, yesterday, this week, next week, overdue, or YYYY-MM-DD");
        process.exit(1);
      }

      filteredTasks = filteredTasks.filter((t) => {
        if (!t.dueDate) return false;
        const taskDate = new Date(t.dueDate);
        return taskDate >= dateRange.start && taskDate <= dateRange.end;
      });
    }

    // Filter by grep pattern if specified
    if (options.grep) {
      const regex = new RegExp(options.grep, "i");
      filteredTasks = filteredTasks.filter((t) =>
        regex.test(t.title) || (t.content ? regex.test(t.content) : false)
      );
    }

    // Sort if specified (before limit, so limit gives top-N of sorted results)
    if (options.sort) {
      const [field, dir] = options.sort.split(":");
      const direction = dir === "desc" ? -1 : 1;
      filteredTasks.sort((a, b) => {
        if (field === "title") {
          return direction * (a.title || "").localeCompare(b.title || "");
        }
        let aVal: number, bVal: number;
        if (field === "priority") {
          aVal = a.priority ?? 0;
          bVal = b.priority ?? 0;
        } else if (field === "created" || field === "sortOrder") {
          aVal = (a as any).sortOrder ?? 0;
          bVal = (b as any).sortOrder ?? 0;
        } else if (field === "dueDate") {
          const noDate = direction > 0 ? Infinity : -Infinity;
          aVal = a.dueDate ? new Date(a.dueDate).getTime() : noDate;
          bVal = b.dueDate ? new Date(b.dueDate).getTime() : noDate;
        } else if (field === "status") {
          aVal = a.status ?? 0;
          bVal = b.status ?? 0;
        } else {
          return 0;
        }
        return aVal < bVal ? -direction : aVal > bVal ? direction : 0;
      });
    }

    // Limit after sort
    if (options.limit) {
      const n = parseInt(options.limit, 10);
      if (!isNaN(n) && n > 0) {
        filteredTasks = filteredTasks.slice(0, n);
      }
    }

    if (options.json) {
      if (options.fields) {
        const fieldList = options.fields.split(",").map((f) => f.trim());
        const picked = filteredTasks.map((task) => {
          const obj: Record<string, unknown> = {};
          for (const f of fieldList) {
            if (f in task) obj[f] = (task as Record<string, unknown>)[f];
          }
          return obj;
        });
        console.log(JSON.stringify(picked, null, 2));
      } else {
        console.log(JSON.stringify(filteredTasks, null, 2));
      }
      return;
    }

    if (filteredTasks.length === 0) {
      console.log("No tasks found.");
      return;
    }

    console.log(`\nTasks (${filteredTasks.length}):\n`);
    for (const task of filteredTasks) {
      console.log(formatTask(task, !options.list));
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

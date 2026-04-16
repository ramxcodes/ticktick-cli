import { api } from "../api";

interface ColumnsOptions {
  json?: boolean;
}

interface Column {
  id: string;
  name: string;
  sortOrder?: number;
}

interface ProjectDataWithColumns {
  project: {
    id: string;
    name: string;
    columns?: Column[];
  };
  tasks: unknown[];
}

export async function columnsCommand(
  projectOrId: string,
  options: ColumnsOptions
): Promise<void> {
  try {
    // Find the project
    const project = await api.findProjectByName(projectOrId);
    if (!project) {
      console.error(`Project not found: ${projectOrId}`);
      process.exit(1);
    }

    // Get project data which includes columns
    const data = await api.getProjectData(project.id);

    const columns = (data as unknown as ProjectDataWithColumns).project?.columns;

    if (options.json) {
      console.log(JSON.stringify(columns || [], null, 2));
      return;
    }

    if (!columns || columns.length === 0) {
      console.log(`No Kanban columns found in project "${project.name}".`);
      console.log("Columns are available when the project view mode is set to Kanban.");
      return;
    }

    console.log(`\nColumns in "${project.name}" (${columns.length}):\n`);
    for (const col of columns) {
      console.log(`  • ${col.name}`);
      console.log(`    id: ${col.id}`);
      if (col.sortOrder !== undefined) {
        console.log(`    sortOrder: ${col.sortOrder}`);
      }
      console.log();
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

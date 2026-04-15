
# TickTick CLI Skill

Manage TickTick tasks and projects from the command line.

## Setup

### 1. Register a TickTick Developer App

1. Go to [TickTick Developer Center](https://developer.ticktick.com/manage)
2. Create a new application
3. Set the redirect URI to `http://localhost:8080`
4. Note your `Client ID` and `Client Secret`

### 2. Authenticate

**For interactive use (opens browser automatically):**
```bash
bun run scripts/ticktick.ts auth --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET
```

**For headless servers (manual OAuth flow):**
```bash
bun run scripts/ticktick.ts auth --client-id YOUR_CLIENT_ID --client-secret YOUR_CLIENT_SECRET --manual
```
**Output:**
```
Credentials saved successfully.

=== Manual Authentication ===

1. Open this URL in your browser:

https://ticktick.com/oauth/authorize?scope=tasks:read%20tasks:write&client_id=...&state=...&redirect_uri=http%3A%2F%2Flocalhost%3A8080&response_type=code

2. Authorize the app
3. You'll be redirected to a URL like: http://localhost:8080/?code=XXXXX&state=STATE
4. Copy that ENTIRE redirect URL and paste it below:

Paste redirect URL: http://localhost:8080/?code=ABC123&state=...

Exchanging code for tokens...

✓ Authentication successful! Tokens saved.
```

**Check authentication status:**
```bash
bun run scripts/ticktick.ts auth --status
```
**Output:**
```
✓ Authenticated with TickTick
```

**Logout (keeps credentials, clears tokens):**
```bash
bun run scripts/ticktick.ts auth --logout
```
**Output:**
```
Logged out successfully. Credentials preserved.
```

---

## Core Workflows for AI Agents

### Workflow 1: Get Project IDs First
**Always start here when working with projects/tasks.**
```bash
bun run scripts/ticktick.ts lists --json
```
**Output:**
```json
[
  {
    "id": "69d0de048f08bed5709498e5",
    "name": "Test Project 1",
    "color": "#FF5733"
  },
  {
    "id": "69d0de048f08bed5709498e6",
    "name": "🏋Body & Health",
    "color": "#F9A825"
  }
]
```
**When to use:** Before creating/moving tasks, when you need to reference a project by ID rather than name for reliability.

---

### Workflow 2: List Tasks with Filters

**List all tasks (human-readable):**
```bash
bun run scripts/ticktick.ts tasks
```
**Output:**
```

Tasks (15):

○ [69d620d7] !!! Important task - due tomorrow
○ [69d6210e] Regular task
○ [69d62153] Overdue test task - due Jan 1
✓ [69d43947] Completed task
```

**List tasks from a specific project:**
```bash
bun run scripts/ticktick.ts tasks --list "Test Project 1" --json
```
**Output:**
```json
[
  {
    "id": "69d621538f08bed57094c296",
    "projectId": "69d620ca8f08bed5709498e5",
    "title": "Overdue test task",
    "status": 0,
    "priority": 0,
    "dueDate": "2025-01-01T23:59:59.000+0000"
  }
]
```
**When to use:** To find tasks in a project, check task IDs before updating/completing.

**Filter by status:**
```bash
bun run scripts/ticktick.ts tasks --status pending
bun run scripts/ticktick.ts tasks --status completed
```

**Filter by date (powerful for daily workflows):**
```bash
# Today's tasks
bun run scripts/ticktick.ts tasks --date today

# Overdue tasks (catch up)
bun run scripts/ticktick.ts tasks --date overdue

# This week's tasks (planning)
bun run scripts/ticktick.ts tasks --date "this week"

# Specific date
bun run scripts/ticktick.ts tasks --date 2025-12-25
```
**Output:**
```

Tasks (3):

○ [69d62153] Task due today
○ [69d620d7] Another task - due today
○ [69d6210e] Third task - due tomorrow
```
**When to use:** Daily standups, weekly planning, catching up on overdue work.

---

### Workflow 2.5: Get a Single Task (Full Details)

Use this when you need one task by ID or exact title.

```bash
# By task ID (most reliable)
bun run scripts/ticktick.ts get-task "694eea8a8e991102e9cf90fd" --json

# By exact title (search across projects)
bun run scripts/ticktick.ts get-task "Websocket server in GO" --json

# By title within a specific project
bun run scripts/ticktick.ts get-task "Websocket server in GO" --list "💻Programming" --json
```

**Output (JSON includes full content, unmasked):**
```json
{
  "id": "694eea8a8e991102e9cf90fd",
  "projectId": "6898e9e5a94951605d41d231",
  "title": "Websocket server in GO",
  "content": "full raw content here",
  "status": 0
}
```

---

### Workflow 3: Create Tasks

**Simple task:**
```bash
bun run scripts/ticktick.ts task "Buy groceries" --list "Personal"
```
**Output:**
```
✓ Task created: "Buy groceries"
  ID: 69d620d78f08ab5f35b111f4
  Project: Personal
```

**Task with all options:**
```bash
bun run scripts/ticktick.ts task "Doctor appointment" \
  --list "Personal" \
  --due tomorrow \
  --priority high \
  --content "Dr. Smith at General Hospital" \
  --tag health important \
  --reminder "30m" \
  --reminder "tomorrow 9am"
```
**Output:**
```
✓ Task created: "Doctor appointment"
  ID: 69d620d78f08ab5f35b111f4
  Project: Personal
  Due: 4/9/2026
```

**All-day task (no time, just date):**
```bash
bun run scripts/ticktick.ts task "Birthday" --list "Personal" --due "2025-06-15" --all-day
```

**Get JSON output for programmatic use:**
```bash
bun run scripts/ticktick.ts task "Meeting" --list "Work" --due today --json
```
**Output:**
```json
{
  "id": "69d622418f08bed57094c296",
  "projectId": "69d620ca8f08bed5709498e5",
  "title": "Meeting",
  "status": 0,
  "priority": 0,
  "dueDate": "2026-04-08T23:59:59.000+0000",
  "kind": "TASK"
}
```

---

### Workflow 4: Create Notes (Not Tasks)

**Simple note:**
```bash
bun run scripts/ticktick.ts task "Meeting notes" --list "Work" --note
```

**Note with content:**
```bash
bun run scripts/ticktick.ts task "Sprint retrospective notes" \
  --list "Work" \
  --content "- What went well: ...\n- What to improve: ..." \
  --note \
  --json
```
**Output:**
```json
{
  "id": "69d622418f08bed57094c296",
  "projectId": "69d620ca8f08bed5709498e5",
  "title": "Sprint retrospective notes",
  "content": "- What went well: ...\n- What to improve: ...",
  "kind": "NOTE",
  "status": 0
}
```
**When to use:** Meeting notes, ideas, free-form content that doesn't need due dates or reminders.

---

### Workflow 5: Checklist Items (Sub-tasks)

**View checklist items:**
```bash
bun run scripts/ticktick.ts checklist list "Buy groceries"
```
**Output:**
```

Checklist items for "Buy groceries" (3):

○ [69d6210e] Milk
○ [69d6210e] Eggs
✓ [69d6210e] Bread
```

**Add checklist items:**
```bash
bun run scripts/ticktick.ts checklist add "Buy groceries" "Milk"
bun run scripts/ticktick.ts checklist add "Buy groceries" "Eggs"
bun run scripts/ticktick.ts checklist add "Buy groceries" "Bread"
```
**Output:**
```
✓ Checklist item added to "Buy groceries"
  ID: checklist-1775640841410
  Title: Milk
```

**Complete checklist item (by name or ID):**
```bash
bun run scripts/ticktick.ts checklist complete "Buy groceries" "Milk"
```
**Output:**
```
✓ Checklist item completed: "Milk"
```

**Delete checklist item:**
```bash
bun run scripts/ticktick.ts checklist delete "Buy groceries" "Eggs"
```

---

### Workflow 6: Complete, Abandon, and Move Tasks

**Complete a task:**
```bash
bun run scripts/ticktick.ts complete "Buy groceries"
```
**Output:**
```
✓ Completed: "Buy groceries"
```

**Mark as won't do (abandon):**
```bash
bun run scripts/ticktick.ts abandon "Old idea"
```
**Output:**
```
✓ Abandoned: "Old idea"
```

**Move task to different project:**
```bash
bun run scripts/ticktick.ts move "Buy groceries" --to "Completed"
```
**Output:**
```
✓ Task moved: "Buy groceries"
  From: Personal
  To: Completed
```

**Move with explicit source (for ambiguous task names):**
```bash
bun run scripts/ticktick.ts move "Review PR" --from "Work" --to "Done"
```

---

### Workflow 7: Update Tasks

**Update by task name:**
```bash
bun run scripts/ticktick.ts task "Buy groceries" --update --priority high
```

**Update by task ID (more reliable):**
```bash
bun run scripts/ticktick.ts task "69d6210e8f08ab5f35b111f4" --update --due tomorrow --content "Updated notes"
```
**Output:**
```
✓ Task updated: "Buy groceries"
  ID: 69d6210e8f08ab5f35b111f4
```

---

### Workflow 8: Batch Operations

**Abandon multiple tasks at once:**
```bash
bun run scripts/ticktick.ts batch-abandon 69d6210e8f08ab5f35b111f4 69d621538f08bed57094c296
```
**Output:**
```
✓ Abandoned 2 task(s)
```

**When to use:** Cleaning up multiple completed/old tasks in one API call.

---

### Workflow 9: Project Management

**List all projects:**
```bash
bun run scripts/ticktick.ts lists
```
**Output:**
```

Projects (5):

• Test Project 1 (ID: 69d620ca8f08bed5709498e5) - Color: #FF5733
• 🏋Body & Health (ID: 69d0de048f08bed5709498e6) - Color: #F9A825
• Personal (ID: 69d0de048f08bed5709498e7)
• Work (ID: 69d0de048f08bed5709498e8) - Color: #4285F4
```

**Create project:**
```bash
bun run scripts/ticktick.ts list "New Project" --color "#FF5733"
```
**Output:**
```
✓ Project created: "New Project"
  ID: 69d620ca8f08bed5709498e5
  Color: #FF5733
```

**Rename project:**
```bash
bun run scripts/ticktick.ts list "Old Name" --update --name "New Name"
```

**Change project color:**
```bash
bun run scripts/ticktick.ts list "Work" --update --color "#00FF00"
```

---

## Options Reference

### Priority Levels
| Level | Value | Display |
|-------|-------|---------|
| `none` | 0 | (no indicator) |
| `low` | 1 | `!` |
| `medium` | 3 | `!!` |
| `high` | 5 | `!!!` |

### Due Date Formats
| Format | Example | Result |
|--------|---------|--------|
| Relative | `today` | Due today |
| Relative | `tomorrow` | Due tomorrow |
| Days from now | `in 3 days` | Due in 3 days |
| Next weekday | `next monday` | Next Monday |
| ISO date | `2025-12-25` | Specific date |

### Date Filters (for `tasks` command)
| Filter | Description |
|--------|-------------|
| `today` | Tasks due today |
| `tomorrow` | Tasks due tomorrow |
| `yesterday` | Tasks due yesterday |
| `this week` | Tasks due this week (Mon-Sun) |
| `next week` | Tasks due next week |
| `overdue` | Overdue tasks |
| `YYYY-MM-DD` | Specific date |

### Reminder Formats
| Format | Example | Result |
|--------|---------|--------|
| Minutes from now | `30m` | 30 minutes later |
| Hours from now | `2h` | 2 hours later |
| Specific time | `9:00` | Today at 9:00 AM (or tomorrow if passed) |
| With day | `today 9am` | Today at 9:00 AM |
| Tomorrow | `tomorrow 9am` | Tomorrow at 9:00 AM |
| ISO datetime | `2025-12-25T09:00:00` | Exact time |

---

## Agent Usage Best Practices

### 1. Always Use `--json` for Reliability
When writing scripts or AI agents, always use `--json` flag:
```bash
# Good - machine readable
bun run scripts/ticktick.ts tasks --list "Work" --date today --json

# Avoid - human readable only
bun run scripts/ticktick.ts tasks --list "Work" --date today
```

### 2. Get Project IDs First
Never guess project IDs. Always fetch them:
```bash
PROJECTS=$(bun run scripts/ticktick.ts lists --json)
WORK_ID=$(echo $PROJECTS | jq -r '.[] | select(.name == "Work") | .id')
```

### 3. Use Task IDs for Updates/Completion
Task names can be ambiguous across projects. Use IDs:
```bash
# Step 1: Get task ID
TASK=$(bun run scripts/ticktick.ts tasks --list "Work" --date today --json | jq '.[0]')
TASK_ID=$(echo $TASK | jq -r '.id')

# Step 2: Use ID for operations
bun run scripts/ticktick.ts task "$TASK_ID" --update --priority high
bun run scripts/ticktick.ts complete "$TASK_ID"
```

### 4. Check for Errors
Always check exit codes:
```bash
if bun run scripts/ticktick.ts task "New Task" --list "Work" --json; then
  echo "Success"
else
  echo "Failed - check if project exists"
fi
```

### 5. Common Error Messages
| Error | Meaning | Fix |
|-------|---------|-----|
| `Not authenticated` | No valid token | Run `auth` command |
| `Project not found` | Invalid project name/ID | Check `lists` command |
| `Task not found` | Task doesn't exist or wrong project | Check `tasks` command |
| `Multiple tasks found` | Ambiguous task name | Use task ID instead |
| `Rate limit exceeded` | Too many API calls | Wait and retry |

---

## Configuration

Tokens are stored in `~/.clawdbot/credentials/ticktick-cli/config.json`:
```json
{
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "accessToken": "...",
  "refreshToken": "...",
  "tokenExpiry": 1234567890000,
  "redirectUri": "http://localhost:8080"
}
```

Note: Credentials are stored in plaintext. The CLI attempts to set file permissions to 700/600; treat this file as sensitive.

The CLI automatically refreshes tokens when they expire.

---

## API Notes

This CLI uses the [TickTick Open API v1](https://developer.ticktick.com/api).

### Curl Structure (OAuth2)

Use the OAuth token from `~/.clawdbot/credentials/ticktick-cli/config.json`:

```bash
TOKEN=$(jq -r '.accessToken' ~/.clawdbot/credentials/ticktick-cli/config.json)
```

Core request pattern:

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  https://api.ticktick.com/open/v1/project
```

Important endpoints:

- List projects: `GET /open/v1/project`
- Fetch tasks for a project: `GET /open/v1/project/{projectId}/data`
- Create task: `POST /open/v1/task`
- Update task: `POST /open/v1/task/{taskId}`

Note: `GET /open/v1/project/{projectId}/task` is not valid (404). Use `/data`.

### Rate Limits
- **100 requests per minute**
- **300 requests per 5 minutes**

The CLI has built-in retry logic with exponential backoff for rate limit errors.

### Task Status Values
| Status | Value | Meaning |
|--------|-------|---------|
| Normal | 0 | Active task |
| Completed | 2 | Done |
| Abandoned | -1 | Won't do |

### Task Kinds
| Kind | Description |
|------|-------------|
| `TASK` | Regular task with due dates, reminders |
| `NOTE` | Free-form note without dates/priorities |

---

## Quick Command Reference

| Command | Purpose | Output |
|---------|---------|--------|
| `lists --json` | Get project IDs | JSON array of projects |
| `tasks --date today --json` | Today's tasks | JSON array of tasks |
| `get-task "<task-id-or-title>" --json` | Get one task | JSON task object with full `content` |
| `task "Title" --list "Project" --json` | Create task | JSON task object |
| `task "Title" --list "Project" --note --json` | Create note | JSON note object |
| `complete "Task" --json` | Complete task | JSON success + task info |
| `checklist add "Task" "Item"` | Add sub-task | Item ID + confirmation |
| `move "Task" --to "Project" --json` | Move task | JSON updated task |
| `tasks --date overdue --json` | Get overdue | JSON array for triage |

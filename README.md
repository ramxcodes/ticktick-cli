# ticktick-cli

A TickTick command-line client for people, shell scripts, and AI agents. It uses only the
[official TickTick Open API](https://developer.ticktick.com/docs/openapi.md).

It is built to be correct first:

- Every command can print one JSON envelope with a coverage flag (`complete`, `partial`, `unknown`).
- A failed project read is never skipped silently.
- Completed-task history is paged past TickTick's 200-row cap.
- The calendar keeps time blocks, moments, deadlines, and all-day tasks apart.
- Recurring occurrences are labelled as server-confirmed or calculated.
- Every write is checked before it is sent and verified after.
- Uncertain writes are reported, not retried blindly.

Upgrading from 0.x? Read [MIGRATION.md](MIGRATION.md).

## Install

Requires [Bun](https://bun.sh) 1.1 or newer.

```bash
bun add -g github:ramxcodes/ticktick-cli#v2.0.0
ticktick --version
```

From a clone:

```bash
git clone https://github.com/ramxcodes/ticktick-cli && cd ticktick-cli
bun install && bun link
```

## Authenticate

The simplest way is a **personal API token**. In the TickTick web app, open
Settings → Account → API Token and create a token. Then pass it to the CLI on stdin, so it
does not end up in your shell history:

```bash
printf '%s' "$TICKTICK_API_TOKEN" | ticktick auth token
ticktick auth status
```

Other options:

| Method | How |
|---|---|
| Environment variable | `export TICKTICK_TOKEN=...` (not saved; overrides the saved token) |
| OAuth in a browser | `TICKTICK_CLIENT_ID=... TICKTICK_CLIENT_SECRET=... ticktick auth login` |
| OAuth on a headless machine | `ticktick auth login --manual`: open the printed URL anywhere, paste the redirect URL back |
| Log out | `ticktick auth logout [--revoke]` |

You get the OAuth client values when you register an app at https://developer.ticktick.com/manage.
Use the redirect URI `http://localhost:8080`. The callback server listens on `127.0.0.1` only.
The API has no refresh grant, so an expired OAuth token means logging in again. Personal tokens
do not expire until you revoke them.

Credentials are kept in `$TICKTICK_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/ticktick-cli`,
otherwise `~/.config/ticktick-cli`. The CLI forces the directory to mode `0700` and files to
`0600`. It refuses symlinks and files owned by another user. Tokens, secrets, and authorization
codes never appear in output.

## Commands

```text
ticktick tasks list        open tasks across projects (filters, sort, fields)
ticktick tasks completed   completed tasks by completion time
ticktick tasks abandoned   won't-do tasks
ticktick tasks complete    <ids...>  batch complete, per-task results
ticktick tasks abandon     <ids...>  batch abandon, per-task results

ticktick task get          <task>    details and lifecycle state
ticktick task create       <title>   create (time block, moment, deadline, all-day, recurring, subtask)
ticktick task update       <task>    change only the given fields
ticktick task complete     <task>    complete (one occurrence for recurring tasks)
ticktick task abandon      <task>    won't do
ticktick task delete       <id>      delete (id only, needs --yes when not interactive)
ticktick task move         <task>    to another project and/or kanban column
ticktick task subtasks     <task>    open subtasks

ticktick checklist list|add|complete|reopen|delete   items inside a task

ticktick agenda            calendar view of a day or range

ticktick projects list|create|update|columns

ticktick auth token|login|status|logout
ticktick config show|set|unset       (setting: timezone)
ticktick ops list|show|resolve       idempotency records from --op-id
ticktick doctor                      configuration, credentials, API, capabilities
```

Run `ticktick <command> --help` for every flag.

`<task>` is a task id, or a title that matches exactly one open task. `<project>` is a
project id, `inbox`, or a name. Name matching works like this:

1. An exact id always wins.
2. Otherwise, a case-insensitive exact name match.
3. Otherwise, a unique partial match.

If more than one candidate matches, the CLI fails with `AMBIGUOUS` and lists the candidates.
It never picks the first one. Completed, abandoned, and deleted tasks can only be addressed
by id.

### Global flags

| Flag | Meaning |
|---|---|
| `--json` | Print exactly one JSON envelope on stdout |
| `--tz <zone>` | IANA timezone for input and output |
| `--dry-run` | Print the write requests a command would send, and send none |
| `--cache-ttl <s>` | Read commands only: reuse GET responses younger than `s` seconds |
| `-v, --verbose` | Print request counts to stderr |

Timezone precedence is `--tz`, then `ticktick config set timezone <zone>`, then your TickTick
account timezone, then the machine timezone.

### Dates

The CLI reads local values in the active timezone:

- `2026-10-29`
- `2026-10-29T14:00` (or `2026-10-29 14:00`)
- an ISO timestamp with an offset, such as `2026-10-29T14:00:00+05:30`
- `today`, `tomorrow`, or `yesterday`, optionally with a time (`tomorrow 9am`)
- a bare time such as `14:30`

Impossible dates such as `2026-02-30` are rejected.

| You pass | Result |
|---|---|
| `--start 12:00 --due 12:15` | Time block from 12:00 to 12:15 |
| `--start 12:00` | A moment (point in time) |
| `--due 17:00` | A deadline |
| `--due 2026-10-29` | All-day task on that date |
| `--start 2026-12-01 --due 2026-12-02` | All-day task over both days |

## Examples

```bash
# Open tasks in one project, high priority first
ticktick tasks list -p Work --sort priority:desc --json

# Everything scheduled this week
ticktick tasks list --from today --to 2026-11-02 --kind interval,point,deadline

# What did I finish in the last 30 days?
ticktick tasks completed --from 2026-09-28 --to today --json

# Today's calendar, including what is already done
ticktick agenda --include-completed

# A 15-minute weekday meeting with a reminder 10 minutes before
ticktick task create "Standup" -p Work --start "tomorrow 10:00" --due "tomorrow 10:15" \
  --repeat "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" --reminder 10m

# Safe automation: preview, then create at most once
ticktick task create "Pay rent" -p Home --due 2026-11-01 --dry-run --json
ticktick task create "Pay rent" -p Home --due 2026-11-01 --op-id rent-2026-11 --json

# Change only the title; tags, reminders, dates, and recurrence are kept
ticktick task update 6a86e88c1d6d446b3f1b1134 --title "Inventory sync" --if-etag 2w2oiurc

# Checklist
ticktick checklist add "Groceries" "Eggs"
ticktick checklist complete "Groceries" eggs
```

## JSON output

With `--json`, stdout contains exactly one document. Diagnostics such as retry notices go to
stderr.

```json
{
  "ok": true,
  "data": [ { "id": "6a86e88c1d6d446b3f1b1134", "title": "Inventory Sync Meeting", "state": "open",
              "schedule": { "kind": "interval", "start": "2026-10-28T12:00:00+05:30", "end": "2026-10-28T12:15:00+05:30" },
              "projectName": "Work", "...": "all raw TickTick fields" } ],
  "meta": {
    "source": "official-open-api",
    "coverage": "complete",
    "timezone": "Asia/Kolkata",
    "fetchedAt": "2026-10-27T13:40:00.000Z",
    "warnings": [],
    "requests": { "count": 15, "retries": 0, "writes": 0 }
  }
}
```

```json
{
  "ok": false,
  "error": { "code": "PARTIAL_DATA", "message": "1 of 13 project reads failed; ...", "details": { "failures": [] } },
  "meta": { "coverage": "unknown", "warnings": [] }
}
```

- Task objects keep every raw API field. The CLI adds `projectName`, `state`
  (`open | completed | abandoned | deleted_or_unknown`), and `schedule`. In `schedule`,
  `kind` is one of `interval`, `point`, `deadline`, `all-day`, `unscheduled`, or `invalid`.
  Times include the offset of the active timezone.
- `meta.coverage` is always `unknown` on errors. On success it is `complete` only when every source the command needed answered in full.
  It is `partial` if some data is missing (for example with `--allow-partial`, or history above
  the API cap). It is `unknown` if the CLI cannot tell, for example a recurring rule it cannot
  expand.
- `--fields id,title,schedule` limits the task keys. Unknown field names are rejected.

### Exit codes and error codes

| Exit | Codes |
|---|---|
| 0 | success |
| 1 | `INTERNAL` |
| 2 | `INVALID_ARGUMENT`, `INVALID_CONFIG` |
| 3 | `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_EXPIRED`, `INSECURE_CREDENTIALS` |
| 4 | `NOT_FOUND`, `TASK_NOT_OPEN`, `REMOTE_MISSING` |
| 5 | `AMBIGUOUS` |
| 6 | `PARTIAL_DATA` |
| 7 | `API_ERROR`, `PERMISSION_DENIED`, `NETWORK_ERROR`, `RATE_LIMITED` |
| 8 | `UNCERTAIN_WRITE`, `VERIFY_FAILED`, `BATCH_PARTIAL_FAILURE` |
| 9 | `CONFLICT`, `OP_ID_CONFLICT` |
| 10 | `UNSUPPORTED_CAPABILITY` |
| 11 | `CONFIRMATION_REQUIRED` |

## Calendar behaviour

`ticktick agenda` covers a half-open range `[start, end)`. The default is today in the active
timezone. Two intervals overlap when `a.start < b.end && b.start < a.end`, so back-to-back
blocks do not conflict.

| Task dates | Kind | Blocks time |
|---|---|---|
| start < due | `interval` | yes |
| start == due, or start only | `point` | no |
| due only | `deadline` | no |
| `isAllDay` | `all-day` (`startDay` to `endDay`, inclusive) | no |
| none | unscheduled (counted in `unscheduledCount`) | no |
| start > due, or a malformed date | listed under `invalid` | no |

The agenda data also contains:

- `busy`: the merged intervals.
- `conflicts`: overlapping interval pairs.
- `recurrence`: what was calculated and what could not be expanded.

**Recurrence.** For a recurring series, TickTick stores only the next due occurrence. That
occurrence is shown with `occurrence.source: "server"`. Later occurrences are calculated from
the RRULE in the task's timezone (DST-safe) and marked `"calculated"`. The CLI expands
`DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY` with `INTERVAL`, `BYDAY` (with ordinals),
`BYMONTHDAY`, `BYMONTH`, and `UNTIL`. These series are listed under
`recurrence.unsupportedSeries` instead, and coverage becomes `unknown`:

- rules with `COUNT`, because the API does not say how many occurrences are left
- series that repeat from the completion date
- rule parts the CLI does not know

Completing an occurrence creates a separate completed task with a new id. It shows up with
`--include-completed`, but nothing links it back to the series.

## API limitations the CLI cannot fix

- `GET /project/{id}/data` returns open tasks only. Completed tasks come from
  `/task/completed`, which returns at most 200 rows per call. The CLI pages past this with a
  time cursor. Only if more than 200 tasks were completed within the same second is the result
  marked `partial`.
- `/task/filter` (used for abandoned tasks) also stops at 200 rows and has no usable paging.
  The CLI splits by project. A project with 200 or more abandoned tasks is reported as
  `partial`.
- A deleted task can still be read by id and looks open (`status 0`). The CLI reports it as
  `deleted_or_unknown` because it is not in the project's open list. It refuses to change it.
- `/task/move` reports success even for tasks that do not exist. The CLI therefore reads every
  move back.
- The API has no idempotency keys. `--op-id` prevents duplicates from this CLI. It cannot
  prevent duplicates from other clients, and a lost response still needs reconciling.
- Skipped or edited occurrences of a recurring task are not exposed, so calculated occurrences
  can be wrong.
- Clearing the dates of a recurring task also clears its recurrence rule (observed server
  behaviour).
- For multi-day all-day tasks, the CLI stores the end as the midnight after the last day. This
  matches what the API returns for tasks the CLI creates. It has not been confirmed against
  multi-day tasks created in the TickTick apps.
- The Inbox has no listed project id. Its real id is learned from its tasks, so moving a task
  into an empty Inbox is not possible.
- Rate limit: about 100 requests in a short window. A full scan uses about 15 requests. On a
  429, all requests pause for the `Retry-After` time.

## Reliability rules

- Reads retry on network errors, timeouts, 429, and 5xx, with jittered exponential backoff.
- Writes are retried only after a rate-limit rejection. A timeout or 5xx on a write returns
  `UNCERTAIN_WRITE`, and the write is not repeated.
- Each write is checked against the server's answer. A move is checked by reading it back.
  Any difference returns `VERIFY_FAILED`, and the task id is included.
- Batch commands return results per task. If any task fails, the command exits 8.
- `--if-etag` fails with `CONFLICT` if the task changed since you read it. Checklist writes
  send the full item list read just before, so use `--if-etag` when other clients may edit
  the same task.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AUTH_REQUIRED` | `ticktick auth token` or set `TICKTICK_TOKEN` |
| `AUTH_INVALID` / `AUTH_EXPIRED` | The token was revoked or expired: log in again |
| `INSECURE_CREDENTIALS` | The config path is a symlink or owned by another user: fix it, or set `TICKTICK_CONFIG_DIR` |
| `PARTIAL_DATA` | A project read failed: re-run, check `error.details.failures`, or pass `--allow-partial` |
| `RATE_LIMITED` | Wait a minute; avoid running many commands at once |
| `UNCERTAIN_WRITE` | Check TickTick first. For `--op-id` operations: `ticktick ops show <id>`, then `ops resolve` |
| Wrong times | `ticktick doctor` shows the active timezone and where it comes from |

Environment variables: `TICKTICK_TOKEN`, `TICKTICK_CONFIG_DIR`, `TICKTICK_CLIENT_ID`,
`TICKTICK_CLIENT_SECRET`, `TICKTICK_TIMEOUT_MS` (default 15000), and `TICKTICK_CONCURRENCY`
(default 4). `TICKTICK_API_BASE` is for tests only.

## Development

```bash
bun install
bun run check                      # strict typecheck + unit and end-to-end tests (fake server)
TICKTICK_LIVE=1 bun run test:live  # live checks in disposable projects, cleaned up afterwards
bun run build                      # single-file binary in dist/ticktick
```

For agents, see [SKILL.md](SKILL.md).

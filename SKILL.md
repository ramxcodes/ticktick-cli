---
name: ticktick
description: Read and change TickTick tasks, projects, checklists, and calendar through the ticktick v2 CLI (official Open API). Use for listing open, completed, or abandoned tasks, building an agenda or free/busy view, and safely creating, updating, completing, moving, or deleting tasks with verified, idempotent writes.
---

# TickTick CLI v2 — agent guide

Always run commands with `--json`. Stdout then holds exactly one envelope. Read `ok` first,
then `meta.coverage`, then `meta.warnings`.

```json
{ "ok": true,  "data": ..., "meta": { "coverage": "complete|partial|unknown", "timezone": "Asia/Kolkata", "warnings": [], "requests": {...} } }
{ "ok": false, "error": { "code": "AMBIGUOUS", "message": "...", "details": {...} }, "meta": {...} }
```

Check setup once with `ticktick doctor --json`. If it reports `AUTH_REQUIRED`, ask the user
for a personal API token (TickTick → Settings → Account → API Token). Then run
`printf '%s' "$TOKEN" | ticktick auth token`, or set `TICKTICK_TOKEN`.

## Rules

1. **Read before you write.** Get the task with `task get <id> --json` or `tasks list --json`
   before you change it. Keep its `id` and `etag`.
2. **Use ids.** After the first lookup, refer to tasks and projects by their 24-character id.
   Titles are accepted only when exactly one open task matches. Otherwise you get `AMBIGUOUS`
   with `error.details.candidates`. Pick one with the user. Never guess.
3. **Check coverage before you draw a conclusion.** "No tasks", "free at 3pm", or "nothing was
   completed" is only true when `ok` is true and `meta.coverage` is `complete`. With `partial`
   or `unknown`, say the answer may be incomplete and repeat the reason from `meta.warnings`.
4. **Missing does not mean completed.** A task can leave the open list because it was
   completed, abandoned, deleted, or moved. Only `task get <id>` says which. Its `state` is
   `open`, `completed`, `abandoned`, or `deleted_or_unknown`. `NOT_FOUND` means not found, not
   done. `completedTime` alone does not prove completion. Use `status`/`state`.
5. **Deadlines are not busy time.** In `agenda`, only entries with `blocksTime: true`
   (kind `interval`) occupy time. Deadlines, points, and all-day tasks do not block hours.
   For availability, use `data.busy` and `data.conflicts`.
6. **Recurrence is partly calculated.** An entry with `occurrence.source: "calculated"` is
   predicted from the RRULE. TickTick does not expose skipped or edited occurrences, so tell
   the user these dates may be wrong. Series in `recurrence.unsupportedSeries` were not
   expanded at all.
7. **Verify every write.** A write is done only when `ok` is true. `VERIFY_FAILED` means the
   request reached TickTick but the result differs: read the task again and report it.
   `BATCH_PARTIAL_FAILURE` lists each task in `error.details.results`.
8. **Never repeat an uncertain write.** On `UNCERTAIN_WRITE`, the change may or may not have
   happened. Check first (`task get`, `tasks list --search`), or use `ops show <op-id>` if you
   passed `--op-id`. Then `ops resolve <op-id> --task <id>` or `--not-applied`.
9. **Use `--op-id` for automation.** Give creates (and completes of recurring tasks) a stable
   key, for example `--op-id daily-plan-2026-10-28-standup`. Running the same key again
   returns `replayed: true` and writes nothing. A different request with the same key fails
   with `OP_ID_CONFLICT`. `REMOTE_MISSING` means the task created earlier is gone. Do not
   recreate it unless the user asks.
10. **Do not overwrite manual work.** Pass `--if-etag <etag>` from your last read. `CONFLICT`
    means someone changed the task: read it again and ask before you continue. Never delete
    or replace tasks you did not create unless the user explicitly asks.
11. **Preview risky changes** with `--dry-run`. It prints the exact requests and sends no write.
12. **Stop on `UNSUPPORTED_CAPABILITY`**, explain the limitation, and do not work around it.

## Read

```bash
ticktick projects list --json                                  # ids and names, plus Inbox
ticktick tasks list --json                                     # all open tasks (complete scan)
ticktick tasks list -p <project> --priority high,medium --tag work --search invoice --json
ticktick tasks list --from today --to 2026-11-02 --kind interval,point,deadline --json
ticktick tasks list --sort due --limit 20 --fields id,title,schedule,etag --json
ticktick tasks completed --from 2026-10-01 --to today --json   # paged past the 200 cap
ticktick tasks abandoned --json
ticktick task get <id> --json                                  # includes state + etag
ticktick task subtasks <id> --json
ticktick checklist list <id> --json
ticktick agenda --json                                         # today
ticktick agenda --date 2026-10-29 --json
ticktick agenda --from 2026-10-29 --to 2026-11-04 --include-completed --json
```

Each task object has every raw TickTick field plus `projectName`, `state`, and `schedule`
(`kind`, and `start`/`end`, `at`, or `startDay`/`endDay`, with timezone offsets).

Agenda `data`: `range`, `entries[]`, `busy[]`, `conflicts[]`, `invalid[]`, `unscheduledCount`,
and `recurrence { calculatedOccurrences, unsupportedSeries, exceptionsVisible: false }`. Each
entry has `taskId`, `title`, `kind`, `blocksTime`, `status`, its time fields, and
`occurrence` (for recurring tasks).

Ranges are half-open. A date-only `--to` includes that whole day; a date-time `--to` is
exclusive. The default timezone comes from the TickTick account. Pass `--tz <IANA>` to change it.

## Write

```bash
# create — date-only values make all-day tasks; start<due is a time block
ticktick task create "Title" -p <project> --start "2026-10-29T10:00" --due "2026-10-29T10:30" \
  --priority high --tag work --reminder 10m --content "notes" --op-id <stable-key> --json
ticktick task create "Pay rent" -p Home --due 2026-11-01 --op-id rent-2026-11 --json
ticktick task create "Standup" -p Work --start "tomorrow 10:00" --due "tomorrow 10:15" \
  --repeat "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" --json
ticktick task create "Sub item" --parent <taskId> --json
ticktick task create "Packing" -p Home --item Passport --item Charger --json

# update — sends only the flags given; other fields are kept
ticktick task update <id> --title "New" --due "2026-10-30T17:00" --if-etag <etag> --json
ticktick task update <id> --add-tag urgent --remove-tag later --json
ticktick task update <id> --clear-due --json        # warning: clearing dates can drop recurrence
ticktick task update <id> --repeat none --json

ticktick task complete <id> --json                  # recurring: outcome "occurrence_completed"
ticktick task complete <id> --op-id <key> --json    # at most once per key
ticktick task abandon <id> --json
ticktick task move <id> --to <project> [--column <columnId>] --json
ticktick task delete <id> --yes --json              # id only; --yes is required in scripts

ticktick tasks complete <id> <id> ... --json        # batch, per-task results
ticktick tasks abandon <id> <id> ... --json

ticktick checklist add <task> "Item" --json
ticktick checklist complete <task> <itemIdOrTitle> --json
ticktick checklist reopen <task> <item> --json
ticktick checklist delete <task> <item> --json
```

Every write accepts `--dry-run`. Writes always use live data. `--cache-ttl` is rejected on
write commands.

## Errors → what to do

| Code (exit) | Meaning | Action |
|---|---|---|
| `INVALID_ARGUMENT` (2) | Bad flag, date, priority, field | Fix the input; nothing was sent |
| `AUTH_*` (3) | No, expired, or rejected token | Ask the user to authenticate |
| `INSECURE_CREDENTIALS` (3) | Config path is a symlink or owned by someone else | Report to the user |
| `NOT_FOUND` (4) | No such task or project | Not "completed"; confirm the id |
| `TASK_NOT_OPEN` (4) | Task is completed, abandoned, or deleted | Report `details.state`; do not retry |
| `REMOTE_MISSING` (4) | `--op-id` task no longer exists | Ask before recreating |
| `AMBIGUOUS` (5) | Several matches | Show `details.candidates`; use an id |
| `PARTIAL_DATA` (6) | Some project reads failed | Retry; or `--allow-partial` and say the data is incomplete |
| `RATE_LIMITED` / `NETWORK_ERROR` (7) | Transient | Wait, then retry reads |
| `UNCERTAIN_WRITE` (8) | Outcome unknown | Check state; do not repeat blindly (rule 8) |
| `VERIFY_FAILED` (8) | Server stored something different | Read the task again; report the difference |
| `BATCH_PARTIAL_FAILURE` (8) | Some batch items failed | Report `details.results`; retry only the failed, still-open ids |
| `CONFLICT` (9) | Task changed since your read (`--if-etag`) | Read it again; ask the user |
| `OP_ID_CONFLICT` (9) | Op id reused for a different request | Use a new key, or fix the request |
| `UNSUPPORTED_CAPABILITY` (10) | The API cannot do this | Stop and explain |
| `CONFIRMATION_REQUIRED` (11) | Destructive action without `--yes` | Get explicit user approval first |

## Limits to tell users about

- Completed history can be partial only if more than 200 tasks were completed within one
  second. Abandoned tasks stop at 200 per project.
- A deleted task looks open when read by id. The CLI reports it as `deleted_or_unknown`.
- There are no server-side idempotency keys. `--op-id` protects only calls made through this CLI.
- About 100 requests per short window. A full `tasks list` uses about 15. Prefer one scan
  with local filtering over many small calls.

# Migrating from ticktick-cli 0.x (v1) to 2.0

v2 is a rewrite with breaking changes to commands, flags, JSON output, date handling, and the
credential location. This is the only document that describes v1. Everything else covers v2.

## 1. Install or update

```bash
bun add -g github:ramxcodes/ticktick-cli#v2.0.0
ticktick --version        # 2.0.0
```

From a clone: `git fetch && git checkout v2.0.0 && bun install && bun link`.

## 2. Credentials

v1 stored credentials in `~/.hermes/credentials/ticktick-cli/config.json`. v2 uses
`$TICKTICK_CONFIG_DIR`, then `$XDG_CONFIG_HOME/ticktick-cli`, then `~/.config/ticktick-cli`.
Pick one option:

**A. Personal API token (recommended, simplest for servers).** In the TickTick web app, go to
Settings → Account → API Token. Then:

```bash
printf '%s' "$TOKEN" | ticktick auth token
```

Or set `TICKTICK_TOKEN` in the service environment and save nothing.

**B. Keep the v1 file.** Point v2 at it:

```bash
export TICKTICK_CONFIG_DIR="$HOME/.hermes/credentials/ticktick-cli"
ticktick doctor
```

v2 reads `accessToken`, `clientId`, `clientSecret`, and `redirectUri` from the v1 file. On
first use it tightens the permissions to `0700`/`0600`. It ignores the v1 `tokenExpiry` field,
so an expired token shows up as `AUTH_INVALID` on the first request. `ticktick doctor` reports
the token source as `personal` for a v1 file, because v1 did not record how the token was
obtained.

**C. OAuth again:** `ticktick auth login --client-id ... --client-secret ...` (add `--manual`
on a headless machine).

## 3. Command mapping

| v1 | v2 |
|---|---|
| `auth --client-id X --client-secret Y` | `auth login --client-id X --client-secret Y` (or env `TICKTICK_CLIENT_ID/SECRET`) |
| `auth --manual` | `auth login --manual` |
| `auth --status` | `auth status` |
| `auth --logout` | `auth logout [--revoke]` |
| — | `auth token` (personal API token from stdin) |
| `tasks` | `tasks list` |
| `tasks --list L` | `tasks list -p L` |
| `tasks --status pending` | `tasks list` (open tasks only) |
| `tasks --status completed` | `tasks completed --from <date> --to <date>` (v1 always returned `[]`) |
| — | `tasks abandoned` |
| `tasks --date today\|tomorrow\|YYYY-MM-DD` | `tasks list --date today` (matches start, due, or interval overlap, not just due) |
| `tasks --date "this week"` / `"next week"` | `tasks list --from <monday> --to <sunday>` |
| `tasks --date overdue` | `tasks list --overdue` |
| `tasks --grep <regex>` | `tasks list --search <text>` (plain text, case-insensitive) |
| `tasks --sort dueDate:asc` | `tasks list --sort due` (fields: project, title, priority, start, due, created, modified) |
| `tasks --fields a,b --limit N` | same flags; unknown fields are now an error |
| `get-task <task> [--list L]` | `task get <task> [-p L]` |
| `get-task --content-only / --grep / --section` | removed: `task get <id> --json \| jq -r .data.content` |
| `task "T" --list L ...` | `task create "T" -p L ...` |
| `task "T" -u ...` | `task update <task> ...` |
| `--from` / `--to` (time block) | `--start` / `--due` |
| `-t a b` (tags) | `--tag a --tag b` |
| `--note` | `--kind note` |
| `-r 9:00`, `-r "tomorrow 9am"` (absolute reminders) | `--reminder 15m\|2h\|1d\|at` (relative to the task time) or `TRIGGER:...` |
| `complete <task> [--list L]` | `task complete <task> [-p L]` |
| `abandon <task>` | `task abandon <task>` |
| `batch-abandon <ids...>` (broken in v1: 404) | `tasks abandon <ids...>` |
| — | `tasks complete <ids...>`, `task delete <id> --yes` |
| `move <task> --to P [--from L] [--column C]` | `task move <task> --to P [-p L] [--column C]` |
| `checklist list\|add\|complete\|delete` | same; `add --due` is now `add --start`; new `checklist reopen` |
| `subtask list <task>` | `task subtasks <task>` |
| `subtask add <task> "T"` | `task create "T" --parent <task>` |
| `subtask complete <task> <sub>` | `task complete <subtaskId>` |
| `lists` | `projects list` |
| `list "N" [--color]` | `projects create "N" [--color]` |
| `list "N" -u --name M` | `projects update "N" --name M` |
| `columns <project>` | `projects columns <project>` |
| — | `agenda`, `doctor`, `config`, `ops` |

## 4. Behaviour changes that affect scripts

- **JSON envelope.** Every `--json` result is `{ "ok": ..., "data" | "error": ..., "meta": ... }`.
  Change `jq '.[]'` to `jq '.data[]'` and `jq .id` to `jq .data.id`. Create, update, and
  complete return `{ "task": ..., ... }` in `data`, so use `.data.task.id`.
- **Errors are JSON too** (on stdout with `--json`) and have stable codes and exit codes (see
  README). v1 always exited 1 and printed plain text.
- **Short ids are gone.** Human output and JSON show full 24-character ids.
- **No IST default.** Times are read and written in `--tz`, then the configured timezone,
  then the TickTick account timezone, then the machine timezone. JSON times carry their offset.
- **Date-only `--due` is an all-day task.** v1 turned `--due 2026-10-29` into 23:59:59 IST
  (a timed deadline). For a timed deadline, pass a time: `--due "2026-10-29T23:59"`.
- **Name matching is strict.** v1 picked the first project whose name contained the text. v2
  accepts an exact name or a unique partial match, and otherwise fails with `AMBIGUOUS`.
- **Failures are not hidden.** v1 skipped projects it could not read. v2 fails with
  `PARTIAL_DATA` unless you pass `--allow-partial`.
- **Writes are verified.** A write that the server did not apply as asked fails with
  `VERIFY_FAILED`. A write that timed out fails with `UNCERTAIN_WRITE` and is not retried.
- **Delete exists and needs `--yes`** in non-interactive use.
- **Checklist completion** stores status `1` (the documented value). v1 wrote `2`.

## 5. Updating a script, step by step

1. Replace each command using the table in section 3.
2. Add `--json` and read `.data`. Check `.ok`, and branch on `.error.code` instead of parsing
   messages.
3. Treat exit codes 4–11 as distinct outcomes (see README). Never retry exit 8
   `UNCERTAIN_WRITE` without checking first.
4. Replace title lookups with ids where you can.
5. For automated creates, add `--op-id <stable key>`.
6. Run once with `--dry-run` and compare the requests with what you expect.

## 6. Rollback

v1 is the commit before the v2 merge (`89195e9`):

```bash
bun add -g github:ramxcodes/ticktick-cli#89195e9
```

v1 reads only `~/.hermes/credentials/ticktick-cli/config.json`. If you used option A or C
above, run v1's `ticktick auth` again, or copy `accessToken` back into that file.

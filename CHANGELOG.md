# Changelog

## 2.0.0 — 2026-10-27

A full rewrite based on the Phase 0 audit (`docs/v2/phase-0-audit.md`). Breaking: see
[MIGRATION.md](MIGRATION.md).

### Added

- Resource/action commands: `tasks list|completed|abandoned|complete|abandon`,
  `task get|create|update|complete|abandon|delete|move|subtasks`,
  `checklist list|add|complete|reopen|delete`, `agenda`, `projects list|create|update|columns`,
  `auth token|login|status|logout`, `config`, `ops`, `doctor`.
- One JSON envelope for every command, with `meta.coverage` (`complete|partial|unknown`),
  timezone, warnings, and request counts. Stable error codes and exit codes.
- Completed-task history through `POST /task/completed`, paged past the 200-row cap with a time
  cursor. Rows that share a boundary timestamp are kept, and the result is marked partial when
  it cannot be split further.
- Abandoned tasks through `POST /task/filter`.
- A calendar engine: half-open intervals; interval, point, deadline, and all-day kinds; busy
  time; conflicts; cross-midnight and DST-safe handling.
- RRULE expansion (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, BYDAY with ordinals,
  BYMONTHDAY, BYMONTH, UNTIL). Occurrences are labelled `server` or `calculated`. COUNT rules,
  repeat-from-completion series, and unknown rule parts are reported as unsupported.
- Task lifecycle state: `open | completed | abandoned | deleted_or_unknown`.
- Safe writes: input validation, `--dry-run` (with a client-level block on writes),
  verification against the server response or a read-back, `--if-etag` conflict detection,
  per-task batch results, and `--op-id` idempotency with a locked local ledger and
  `ops show|resolve` reconciliation.
- Personal API token support (`auth token`, `TICKTICK_TOKEN`), OAuth over a 127.0.0.1-only
  loopback, and manual OAuth for headless machines. `auth logout --revoke`.
- Timezone precedence: `--tz`, then config, then TickTick account (`/preference`), then machine.
- Optional read cache (`--cache-ttl`), keyed per token, never used by writes.
- `doctor` diagnostics. Strict TypeScript, unit tests, end-to-end tests against a fake server,
  and an opt-in live test that runs in disposable projects.

### Fixed (audit defects D1–D24)

- D1 `batch-abandon` called a non-existent endpoint (`/batch/task`): now `/task/batch` with
  per-item errors.
- D2 `--status completed` always returned `[]`: replaced by `tasks completed`.
- D3 Project read errors were swallowed, and an unknown project's `{}` looked empty.
- D4/D5 First-substring project matching and inconsistent `--list` matching.
- D6/D7 Hard-coded IST, and date filters that only looked at `dueDate`.
- D8 Fabricated checklist ids, wrong completion status (`2` instead of `1`), unverified array
  replacement.
- D9 Silent dropping of invalid dates and priorities.
- D10/D11 Writes not read back; partial-update field preservation is now verified live.
- D12–D15 Credential permissions, leaked authorization codes and token-exchange bodies,
  unescaped OAuth HTML, no headless token support.
- D16 Unsafe retries, no timeout. D17 Plain-text errors with exit 1. D18 Unvalidated `--fields`
  and regexes.
- D19 No delete command. D20 Sequential scans. D21–D23 Duplicated and dead code, no tests or
  typecheck. D24 Documentation of broken commands.

### Removed

- All v1 command names and flags, short ids, `get-task --content-only/--grep/--section`,
  regex `--grep`, absolute reminder times, the `open` dependency, and `package-lock.json`.

### Known limitations

- `/task/completed` and `/task/filter` stop at 200 rows. History is partial only if more than
  200 tasks were completed within one second. Abandoned tasks stop at 200 per project.
- Deleted tasks remain readable by id with status 0. They are reported as `deleted_or_unknown`.
- `/task/move` reports success for unknown tasks. Moves are verified by reading them back.
- No server-side idempotency: `--op-id` protects only calls made through this CLI.
- Skipped or edited recurring occurrences are not exposed, so calculated occurrences may be
  wrong. Completed occurrences are separate tasks with no link to their series.
- Clearing a recurring task's dates also clears its recurrence rule (server behaviour).
- The multi-day all-day end convention (exclusive midnight) is verified only for tasks the CLI
  creates.
- The Inbox id is only known when the Inbox has an open task.

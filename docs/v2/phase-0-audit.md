# TickTick CLI v2 — Phase 0 audit

- Date: 2026-10-27
- Base commit: `89195e9`
- Official API source: `https://developer.ticktick.com/docs/openapi.md` (docsify source of the developer docs)
- Live probes: read-only (GET, plus documented read-only POST queries). One empty `{}` body was sent to each batch path; it creates nothing.
- Test account: 12 projects + Inbox, 254 pending tasks, timezone `Asia/Kolkata`.

## 1. Headline findings

1. **Completed history IS available in the official API** (`POST /task/completed`). The CLI uses `/project/{id}/data`, which the docs define as "undone tasks only". This is the root cause of "completed query returned zero".
2. **`batch-abandon` is broken.** It calls `POST /batch/task`, which returns 404. The documented path is `POST /task/batch`.
3. **Several official endpoints silently truncate.** `task/completed` and `task/filter` return at most 200 rows with no flag. `task/undone` returns `[]` when the range is longer than 14 days. The CLI must detect this and never call it "complete".
4. **Project read failures are swallowed** (`catch { continue }`) in every multi-project scan. A failed project gives a partial result that looks complete.
5. **All date parsing and printing is hard-coded to IST.** Wrong for every non-IST user.
6. **No tests, no `tsconfig.json`, no typecheck.**

## 2. API capability matrix

Legend — Doc: in official docs. Live: result of the probe on this account.

### Endpoints the CLI uses today

| CLI command | Method + endpoint | Doc | Live | Limits / notes |
|---|---|---|---|---|
| `lists`, all name lookups | `GET /project` | Yes | 200, 12 rows, ~1.0 s | Omits Inbox. Supports `offset`/`limit` (default 200). CLI does not paginate. |
| `tasks`, task lookups, `columns`, checklist, subtask | `GET /project/{id}/data` | Yes | 200, ~250 ms each | **Undone tasks only.** Unknown project id returns **200 `{}`**, not 404. |
| Inbox scan | `GET /project/inbox/data` | Yes (`inbox` alias in undone docs) | 200 | Real Inbox id appears only in task `projectId`. |
| `task` (create), `subtask add` | `POST /task` | Yes | not run (write) | Accepts `timeZone`, `repeatFlag`, `items`, `parentId`. CLI never sends `timeZone`. |
| `task -u`, `abandon`, `subtask complete`, checklist writes | `POST /task/{id}` | Yes | not run (write) | Partial-update field preservation **not verified**. Needs isolated live test. |
| `complete` | `POST /project/{p}/task/{t}/complete` | Yes | not run (write) | No response body. |
| `move` | `POST /task/move` (array body) | Yes | not run (write) | Returns `[{id, etag}]`. |
| `batch-abandon` | `POST /batch/task` | **No** | **404** | **Broken.** Correct path is `/task/batch`. |
| `list` (create/update) | `POST /project`, `POST /project/{id}` | Yes | not run (write) | — |
| (unused) | `DELETE /project/{p}/task/{t}` | Yes | — | `api.deleteTask` exists, no command uses it. |

### Official endpoints the CLI does not use yet

| Endpoint | Live | Behaviour observed | Use in v2 |
|---|---|---|---|
| `GET /project/{p}/task/{t}` | 200 ~250 ms; missing task → **404** with `{errorId,errorCode,errorMessage}` | Single-task read. | Read-back after writes. Fast ID lookup when project is known. |
| `POST /task/completed` `{projectIds?, startDate?, endDate?}` | 200 ~300 ms. 7 d → 28, 30 d → 123, 365 d → **200 (capped)** | Sorted newest first by `completedTime`. Status always `2`. | `--status completed`. Paginate by moving `endDate` to the oldest `completedTime` returned, dedupe by id. |
| `POST /task/filter` `{projectIds, startDate, endDate, priority, tag, kind, status}` | 200. `status:[0]` → **200 (capped; real count 254)**. `status:[-1]` → 27 | Date range applies to **`startDate`** only. | Abandoned tasks (`status -1`). Server-side pre-filter, only when result < 200. |
| `POST /task/undone` `{projectIds?, taskIds?, startDate, endDate}` | 14 d → 5 rows. 30 d → **`[]`** (silent). | Max 14-day range. **One row per series** (next occurrence only, no expansion). | Agenda source for ≤14-day windows, chunked. |
| `POST /task/search` `{keywords, projectIds, tags, status, dueFrom, dueTo}` | 200. Blank keywords → `[]` | `status:[2]` returned 0 where completed matches exist — completed coverage unclear. | Optional `--grep` accelerator. Not trusted for completed. |
| `POST /task/completeTasks` | not run (write) | ≤50 ids, one project. Returns ids that succeeded. | Batch complete. |
| `POST /task/batch` | empty body → 200 `{status,items,id2etag,id2error}` | ≤50 add + ≤50 update. Per-id errors: `EXISTED`, `DELETED`, `NOT_EXISTED`, `PROJECT_MOVE_ERROR`, … | Fix `batch-abandon`. Per-item results. |
| `POST /preference` | 200 `{timeZone}` | Account timezone. | Default timezone source. |
| `GET /project/{p}/column`, `GET /tag`, `GET /project/group` | 200 | — | `columns` can use the dedicated endpoint. |
| Comments, assign, focus, habits, countdown, project delete, column/tag/group writes | not probed | — | Out of v2 scope unless asked. |

### Auth

| Item | Finding |
|---|---|
| OAuth state | Validated in both flows. Good. |
| Callback bind | `127.0.0.1` only. Good. |
| Refresh | Docs say `grant_type` is "only authorization_code". Saved config has **no `refreshToken`**. Refresh path is unverified dead code. Token lifetime ≈ 180 days. |
| Personal API token | **Docs now offer a personal token** (Settings → Account → API Token). Good fit for headless and env-var use. |
| Revoke | `POST /oauth/revoke` exists. `--logout` only deletes local tokens. |
| Rate limit | 429 hit after ~100 requests in ~2 min. No `Retry-After` / rate-limit headers seen. |

## 3. Observed data facts (affect design)

- 254 pending tasks: **247 have no date**, 7 have dates. 6 of 7 have `startDate == dueDate` (point in time, zero length). 1 is a real block (15 min). 0 all-day.
- Date format on all records: `yyyy-MM-ddTHH:mm:ss.SSS+0000`.
- `timeZone` is `Asia/Kolkata` or **empty string**.
- 8 pending tasks have `completedTime` with `status 0` (1 recurring). So `completedTime` alone does not mean completed. Confirmed.
- Recurrence seen: `FREQ=DAILY;INTERVAL=1` and `FREQ=WEEKLY;BYDAY=MO..FR`. `repeatFrom` is `"2"` or absent.
- **Completing a recurring occurrence creates a new task record with a new id, `status 2`, and no `repeatFlag`.** The series keeps its id and moves to the next date. No field linking the copy to the series was seen. So: past occurrences are confirmed by the server but only linkable by title/time; future occurrences must be calculated locally; exceptions (skips, edits) are not exposed.
- Checklist item `status` values seen: `0, 1, 2`. Docs say completed = `1`. CLI writes `2`.
- Extra undocumented task fields present: `createdTime`, `modifiedTime`, `etag`, `etimestamp`, `isFloating`, `childIds`, `columnName`, `progress`. `etag` + `modifiedTime` are useful for edit detection (FR-07).

## 4. Baseline measurements

| Measurement | Result |
|---|---|
| `ticktick tasks --json` wall time (3 runs) | 5.07 s, 5.15 s, 5.04 s |
| Requests per full scan | 14 (1 `/project` + 13 `/data`). `get-task <id>` also ~14. |
| Sequential `/data` for 13 projects | 4.1 s |
| Parallel `/data` for 13 projects | 1.6 s |
| `POST /task/completed` | ~0.3 s for up to 200 rows |

## 5. Defect list (prioritised)

### P0 — wrong data or broken writes

| # | Defect | Where |
|---|---|---|
| D1 | `batch-abandon` calls `/batch/task` → 404 every time. Command never worked as shipped. | `api.ts` `batchTasks` |
| D2 | `tasks --status completed` always returns `[]` with exit 0. Source endpoint has no completed tasks. | `tasks.ts` |
| D3 | Project read errors swallowed in `tasks`, `findTaskById`, `findTaskByTitle`, `getAllTasks`. Partial data reported as complete. Unknown project returns `{}` and is treated as "no tasks". | `api.ts`, `tasks.ts` |
| D4 | `findProjectByName` falls back to the **first substring match**. `--list Work` can create/move into the wrong project with no warning. | `api.ts` |
| D5 | `--list` in task lookup uses exact name only, but create uses substring. A name that works for create gives "Task not found" for update. | `api.ts` `findTaskByTitle` |
| D6 | IST hard-coded for all input parsing and display. `--date today` uses the machine timezone instead. Results differ by machine. | `task.ts`, `tasks.ts` |
| D7 | `--date` filters on `dueDate` only, end-inclusive `23:59:59.999`. A block starting in range but due outside is dropped. | `tasks.ts` |
| D8 | Checklist add sends a fake id `checklist-<timestamp>` and returns the local object, not the server's. Every checklist write rewrites the whole `items` array (lost update if two writers). Complete writes status `2`; docs say `1`. | `api.ts` checklist methods |
| D9 | `subtask add --due` and `checklist add --due` use `new Date(str)`. Invalid dates are silently dropped. Invalid subtask priority silently ignored. | `subtask.ts`, `checklist.ts` |
| D10 | Writes never read back. `complete`/`abandon` JSON says success from local data. | all write commands |
| D11 | Partial update field preservation (reminders, repeatFlag, dates) **unverified**. `--tag` replaces all tags. | `task.ts` update |

### P1 — reliability, security, contract

| # | Defect | Where |
|---|---|---|
| D12 | Credential file is `664`, dir `775` on this machine (group/world readable). CLI does not check or repair on load. | `~/.hermes/credentials/ticktick-cli/` |
| D13 | Manual auth error prints the full redirect URL, including the auth code. Real error (e.g. state mismatch) is replaced by a generic one. | `auth.ts` `authenticateManual` |
| D14 | Token exchange error prints the raw server body. OAuth `error` param is put into HTML unescaped. | `auth.ts` |
| D15 | No env-var token, no personal-token support. | `auth.ts` |
| D16 | Retry: fixed 5/15/30/60 s, no jitter, no request timeout. POSTs retried on 429 / `exceed_query_limit` (probably safe — request rejected — but undocumented). | `api.ts` `request` |
| D17 | Errors are plain text on stderr. No error codes, no JSON error body, exit code always 1. | all commands |
| D18 | `--fields` with unknown names returns `[{}, {}, …]`. Invalid `--grep` regex fails only after the full network scan. | `tasks.ts`, `get-task.ts` |
| D19 | No delete command, though PRD lists delete. | — |

### P2 — maintainability, performance

| # | Defect |
|---|---|
| D20 | Sequential project reads (5 s). `listProjects` called 2–3× per command. |
| D21 | `isTaskId` copied in 8 files. Task-resolve block copied ~12×. Trigger parser copied in 2 files. |
| D22 | No tests, no `tsconfig.json`, no typecheck, version string in 2 places. |
| D23 | Dead code: `getInboxId`, `getInboxData`, `getAllTasks`, `PRIORITY_REVERSE` import, refresh path. |
| D24 | README and SKILL.md document `tasks --status completed` and `batch-abandon` — both do not work. |

## 6. Open questions for the owner

See chat summary. Answers are needed before Phase 1 design.

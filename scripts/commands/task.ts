import { api, PRIORITY_MAP, type CreateTaskInput, type UpdateTaskInput } from "../api";

interface TaskCreateOptions {
  list: string;
  content?: string;
  priority?: string;
  due?: string;
  tag?: string[];
  reminder?: string[];
  allDay?: boolean;
  note?: boolean;
  json?: boolean;
}

interface TaskUpdateOptions {
  update: boolean;
  list?: string;
  content?: string;
  priority?: string;
  due?: string;
  tag?: string[];
  json?: boolean;
}

// Check if string looks like a task ID (24-char hex)
function isTaskId(str: string): boolean {
  return /^[a-f0-9]{24}$/i.test(str);
}

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

type IstParts = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
};

function nowInIstParts(reference: Date = new Date()): IstParts {
  const shifted = new Date(reference.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
    milliseconds: shifted.getUTCMilliseconds(),
  };
}

function istPartsToDate(parts: IstParts): Date {
  const utcMillis = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hours,
    parts.minutes,
    parts.seconds,
    parts.milliseconds
  ) - IST_OFFSET_MS;
  return new Date(utcMillis);
}

function toTickTickIso(date: Date): string {
  return date.toISOString().replace("Z", "+0000");
}

function hasExplicitTimezone(value: string): boolean {
  return /(z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

function parseTimePart(timePart: string): { hours: number; minutes: number } | undefined {
  const normalized = timePart.trim().toLowerCase();

  // 14:30
  const twentyFourHour = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHour) {
    const hours = parseInt(twentyFourHour[1], 10);
    const minutes = parseInt(twentyFourHour[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { hours, minutes };
    }
    return undefined;
  }

  // 9am, 9:15pm, 12 am
  const twelveHour = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (twelveHour) {
    const rawHour = parseInt(twelveHour[1], 10);
    const minutes = twelveHour[2] ? parseInt(twelveHour[2], 10) : 0;
    const meridian = twelveHour[3];

    if (rawHour < 1 || rawHour > 12 || minutes < 0 || minutes > 59) {
      return undefined;
    }

    let hours = rawHour % 12;
    if (meridian === "pm") {
      hours += 12;
    }

    return { hours, minutes };
  }

  return undefined;
}

function formatUtcIst(timestamp: string): { utc: string; ist: string } {
  const date = new Date(timestamp);
  const utc = date.toLocaleString("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const ist = date.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return { utc: `${utc} UTC`, ist: `${ist} IST` };
}

function parseReminder(reminderStr: string): string {
  const now = new Date();
  const nowIst = nowInIstParts(now);
  const lowerReminder = reminderStr.toLowerCase().trim();

  // Relative reminders: 30m, 2h
  let match = lowerReminder.match(/^(\d+)\s*(m|min|mins|minute|minutes)$/i);
  if (match) {
    const minutes = parseInt(match[1], 10);
    return toTickTickIso(new Date(now.getTime() + minutes * 60 * 1000));
  }

  match = lowerReminder.match(/^(\d+)\s*(h|hr|hrs|hour|hours)$/i);
  if (match) {
    const hours = parseInt(match[1], 10);
    return toTickTickIso(new Date(now.getTime() + hours * 60 * 60 * 1000));
  }

  // Time only (interpreted in IST by default)
  const timeOnly = parseTimePart(reminderStr);
  if (timeOnly) {
    let target: IstParts = {
      ...nowIst,
      hours: timeOnly.hours,
      minutes: timeOnly.minutes,
      seconds: 0,
      milliseconds: 0,
    };

    let targetDate = istPartsToDate(target);
    if (targetDate.getTime() <= now.getTime()) {
      const tomorrowInIst = istPartsToDate({
        ...nowIst,
        day: nowIst.day + 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        milliseconds: 0,
      });
      const tomorrowParts = nowInIstParts(tomorrowInIst);
      target = {
        ...tomorrowParts,
        hours: timeOnly.hours,
        minutes: timeOnly.minutes,
        seconds: 0,
        milliseconds: 0,
      };
      targetDate = istPartsToDate(target);
    }

    return toTickTickIso(targetDate);
  }

  // today/tomorrow + time (interpreted in IST)
  if (lowerReminder.startsWith("today ") || lowerReminder.startsWith("tomorrow ")) {
    const isTomorrow = lowerReminder.startsWith("tomorrow ");
    const timePart = reminderStr.substring(isTomorrow ? 9 : 6);
    const parsedTime = parseTimePart(timePart);

    if (parsedTime) {
      const base = isTomorrow
        ? nowInIstParts(istPartsToDate({
            ...nowIst,
            day: nowIst.day + 1,
            hours: 0,
            minutes: 0,
            seconds: 0,
            milliseconds: 0,
          }))
        : nowIst;

      return toTickTickIso(
        istPartsToDate({
          ...base,
          hours: parsedTime.hours,
          minutes: parsedTime.minutes,
          seconds: 0,
          milliseconds: 0,
        })
      );
    }
  }

  // Date-time string without timezone: treat as IST by default
  if (!hasExplicitTimezone(reminderStr)) {
    const parsedLocal = reminderStr.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );

    if (parsedLocal) {
      const year = parseInt(parsedLocal[1], 10);
      const month = parseInt(parsedLocal[2], 10);
      const day = parseInt(parsedLocal[3], 10);
      const hours = parsedLocal[4] ? parseInt(parsedLocal[4], 10) : 0;
      const minutes = parsedLocal[5] ? parseInt(parsedLocal[5], 10) : 0;
      const seconds = parsedLocal[6] ? parseInt(parsedLocal[6], 10) : 0;

      return toTickTickIso(
        istPartsToDate({
          year,
          month,
          day,
          hours,
          minutes,
          seconds,
          milliseconds: 0,
        })
      );
    }
  }

  // Otherwise parse as absolute datetime (if timezone is explicit)
  const parsed = new Date(reminderStr);
  if (!isNaN(parsed.getTime())) {
    return toTickTickIso(parsed);
  }

  throw new Error(`Invalid reminder format: ${reminderStr}. Try '30m', '2h', '9:00', 'tomorrow 9am', or ISO date.`);
}

function parseDueDate(dueStr: string): string {
  const lowerDue = dueStr.toLowerCase().trim();
  const nowIst = nowInIstParts();

  const toIstEndOfDay = (parts: IstParts): string => {
    return toTickTickIso(
      istPartsToDate({
        ...parts,
        hours: 23,
        minutes: 59,
        seconds: 59,
        milliseconds: 0,
      })
    );
  };

  if (lowerDue === "today") {
    return toIstEndOfDay(nowIst);
  }

  if (lowerDue === "tomorrow") {
    const tomorrowParts = nowInIstParts(
      istPartsToDate({
        ...nowIst,
        day: nowIst.day + 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
        milliseconds: 0,
      })
    );
    return toIstEndOfDay(tomorrowParts);
  }

  let match = lowerDue.match(/^in (\d+) days?$/i);
  if (match) {
    const days = parseInt(match[1], 10);
    const targetParts = nowInIstParts(
      istPartsToDate({
        ...nowIst,
        day: nowIst.day + days,
        hours: 0,
        minutes: 0,
        seconds: 0,
        milliseconds: 0,
      })
    );
    return toIstEndOfDay(targetParts);
  }

  match = lowerDue.match(/^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  if (match) {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const targetDay = days.indexOf(match[1].toLowerCase());
    const currentDay = new Date(Date.now() + IST_OFFSET_MS).getUTCDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;

    const targetParts = nowInIstParts(
      istPartsToDate({
        ...nowIst,
        day: nowIst.day + daysUntil,
        hours: 0,
        minutes: 0,
        seconds: 0,
        milliseconds: 0,
      })
    );

    return toIstEndOfDay(targetParts);
  }

  // Date-only input defaults to IST end-of-day
  const dateOnly = lowerDue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return toTickTickIso(
      istPartsToDate({
        year: parseInt(dateOnly[1], 10),
        month: parseInt(dateOnly[2], 10),
        day: parseInt(dateOnly[3], 10),
        hours: 23,
        minutes: 59,
        seconds: 59,
        milliseconds: 0,
      })
    );
  }

  // Date-time string without timezone: treat as IST
  if (!hasExplicitTimezone(dueStr)) {
    const parsedLocal = dueStr.match(
      /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );

    if (parsedLocal) {
      return toTickTickIso(
        istPartsToDate({
          year: parseInt(parsedLocal[1], 10),
          month: parseInt(parsedLocal[2], 10),
          day: parseInt(parsedLocal[3], 10),
          hours: parseInt(parsedLocal[4], 10),
          minutes: parseInt(parsedLocal[5], 10),
          seconds: parsedLocal[6] ? parseInt(parsedLocal[6], 10) : 0,
          milliseconds: 0,
        })
      );
    }
  }

  // Fallback: parse as absolute date-time with explicit timezone
  const parsed = new Date(dueStr);
  if (!isNaN(parsed.getTime())) {
    return toTickTickIso(parsed);
  }

  throw new Error(`Invalid date format: ${dueStr}. Try 'today', 'tomorrow', 'in 3 days', or ISO date.`);
}

export async function taskCreateCommand(
  title: string,
  options: TaskCreateOptions
): Promise<void> {
  try {
    // Find the project
    const project = await api.findProjectByName(options.list);
    if (!project) {
      console.error(`Project not found: ${options.list}`);
      process.exit(1);
    }

    const input: CreateTaskInput = {
      title,
      projectId: project.id,
    };

    if (options.content) {
      input.content = options.content;
    }

    if (options.priority) {
      const priority = PRIORITY_MAP[options.priority.toLowerCase()];
      if (priority === undefined) {
        console.error(
          `Invalid priority: ${options.priority}. Use none, low, medium, or high.`
        );
        process.exit(1);
      }
      input.priority = priority;
    }

    if (options.due) {
      input.dueDate = parseDueDate(options.due);
    }

    if (options.tag && options.tag.length > 0) {
      input.tags = options.tag;
    }

    if (options.reminder && options.reminder.length > 0) {
      // Parse reminders - can be relative or absolute
      input.reminders = options.reminder.map(parseReminder);
    }

    if (options.allDay) {
      input.isAllDay = true;
    }

    if (options.note) {
      input.kind = "NOTE";
    }

    const task = await api.createTask(input);

    if (options.json) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    console.log(`✓ Task created: "${task.title}"`);
    console.log(`  ID: ${task.id}`);
    console.log(`  Project: ${project.name}`);

    const dueDateToShow = task.dueDate || input.dueDate;
    if (dueDateToShow) {
      const dueTime = formatUtcIst(dueDateToShow);
      console.log(`  Due UTC: ${dueTime.utc}`);
      console.log(`  Due IST: ${dueTime.ist}`);
    }

    const remindersToShow = task.reminders && task.reminders.length > 0
      ? task.reminders
      : input.reminders;

    if (remindersToShow && remindersToShow.length > 0) {
      remindersToShow.forEach((reminder, index) => {
        const reminderTime = formatUtcIst(reminder);
        console.log(`  Reminder ${index + 1} UTC: ${reminderTime.utc}`);
        console.log(`  Reminder ${index + 1} IST: ${reminderTime.ist}`);
      });
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

export async function taskUpdateCommand(
  taskNameOrId: string,
  options: TaskUpdateOptions
): Promise<void> {
  try {
    let found: { task: { id: string; title: string }; projectId: string } | undefined;

    // If it looks like an ID and no --list specified, use findTaskById
    if (isTaskId(taskNameOrId) && !options.list) {
      found = await api.findTaskById(taskNameOrId);
    } else {
      // Search by title (with optional project filter)
      found = await api.findTaskByTitle(taskNameOrId, options.list);
    }

    if (!found) {
      console.error(`Task not found: ${taskNameOrId}`);
      process.exit(1);
    }

    const { task, projectId } = found;

    const input: UpdateTaskInput = {
      id: task.id,
      projectId: projectId,
    };

    // Only include fields that are explicitly set
    if (options.content !== undefined) {
      input.content = options.content;
    }

    if (options.priority) {
      const priority = PRIORITY_MAP[options.priority.toLowerCase()];
      if (priority === undefined) {
        console.error(
          `Invalid priority: ${options.priority}. Use none, low, medium, or high.`
        );
        process.exit(1);
      }
      input.priority = priority;
    }

    if (options.due) {
      input.dueDate = parseDueDate(options.due);
    }

    if (options.tag && options.tag.length > 0) {
      input.tags = options.tag;
    }

    const updated = await api.updateTask(input);

    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    console.log(`✓ Task updated: "${updated.title}"`);
    console.log(`  ID: ${updated.id}`);

    const updatedDue = updated.dueDate || input.dueDate;
    if (updatedDue) {
      const dueTime = formatUtcIst(updatedDue);
      console.log(`  Due UTC: ${dueTime.utc}`);
      console.log(`  Due IST: ${dueTime.ist}`);
    }

    if (updated.reminders && updated.reminders.length > 0) {
      updated.reminders.forEach((reminder, index) => {
        const reminderTime = formatUtcIst(reminder);
        console.log(`  Reminder ${index + 1} UTC: ${reminderTime.utc}`);
        console.log(`  Reminder ${index + 1} IST: ${reminderTime.ist}`);
      });
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

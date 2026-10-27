import { CliError } from "./errors";

/**
 * Timezone-aware date helpers built on Intl. All instants are epoch milliseconds.
 * "Wall time" means the calendar date and clock time a person in `tz` sees.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Returns `tz` if it is a valid IANA zone, otherwise throws INVALID_ARGUMENT. */
export function assertTimeZone(tz: string): string {
  try {
    formatterFor(tz);
    return tz;
  } catch {
    throw new CliError("INVALID_ARGUMENT", `Unknown timezone: ${tz}. Use an IANA name such as Asia/Kolkata.`);
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Wall time and weekday (0 = Sunday) of an instant in `tz`. */
export function zonedParts(ms: number, tz: string): WallTime & { weekday: number } {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number]),
  };
}

/** UTC offset of `tz` at instant `ms`, in milliseconds. */
export function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant for a wall time in `tz`. During a DST gap the wall time does not exist
 * and the result moves forward by the gap; during an overlap the earlier instant wins.
 */
export function zonedToInstant(w: WallTime, tz: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = naive - offsetMs(naive, tz);
  const second = naive - offsetMs(first, tz);
  if (first === second) return first;
  // Offsets differ around a transition: prefer the candidate whose wall time matches.
  const matches = (ms: number) => {
    const p = zonedParts(ms, tz);
    return p.hour === w.hour && p.minute === w.minute && p.day === w.day;
  };
  if (matches(Math.min(first, second))) return Math.min(first, second);
  if (matches(Math.max(first, second))) return Math.max(first, second);
  return Math.max(first, second);
}

export function startOfLocalDay(d: LocalDate, tz: string): number {
  return zonedToInstant({ ...d, hour: 0, minute: 0, second: 0 }, tz);
}

/** Calendar arithmetic on local dates (no timezone involved). */
export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function localDateOf(ms: number, tz: string): LocalDate {
  const { year, month, day } = zonedParts(ms, tz);
  return { year, month, day };
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

export function formatLocalDate(d: LocalDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** ISO 8601 with the numeric offset of `tz`, e.g. 2026-10-28T12:00:00+05:30. */
export function formatIso(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  const off = Math.round(offsetMs(ms, tz) / 60000);
  const sign = off < 0 ? "-" : "+";
  return `${formatLocalDate(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Date format the TickTick API expects: yyyy-MM-dd'T'HH:mm:ss.SSS+0000 (UTC). */
export function formatApiDate(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

const API_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Parses a TickTick API timestamp. Returns undefined when empty, null when malformed. */
export function parseApiDate(value: string | undefined | null): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const m = API_DATE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "0", zone = "Z"] = m;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, "0")));
  if (zone === "Z") return base;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
  return base - offset;
}

export interface ParsedInput {
  ms: number;
  /** true when the input had no time part (a whole calendar day). */
  dateOnly: boolean;
  date: LocalDate;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const ABSOLUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function checkedDate(year: number, month: number, day: number, input: string): LocalDate {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CliError("INVALID_ARGUMENT", `Invalid date: ${input}`);
  }
  return { year, month, day };
}

function parseClock(text: string): { hour: number; minute: number } | undefined {
  const t = text.trim().toLowerCase();
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
  }
  const h12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(t);
  if (h12) {
    const raw = Number(h12[1]);
    const minute = h12[2] ? Number(h12[2]) : 0;
    if (raw < 1 || raw > 12 || minute > 59) return undefined;
    return { hour: (raw % 12) + (h12[3] === "pm" ? 12 : 0), minute };
  }
  return undefined;
}

/**
 * Parses a user-supplied date or date-time, interpreting local values in `tz`.
 * Accepted: YYYY-MM-DD, YYYY-MM-DDTHH:mm[:ss], ISO with offset or Z,
 * today|tomorrow|yesterday [time], or a bare time (today). Times: 14:30, 9am, 9:15pm.
 */
export function parseUserDate(input: string, tz: string, now: number): ParsedInput {
  const text = input.trim();
  const invalid = () =>
    new CliError(
      "INVALID_ARGUMENT",
      `Invalid date: "${input}". Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, an ISO timestamp with offset, today/tomorrow/yesterday [time], or a time like 14:30.`,
    );

  if (ABSOLUTE.test(text)) {
    const ms = parseApiDate(text.replace(/z$/i, "Z"));
    if (typeof ms !== "number") throw invalid();
    const [y, mo, d] = text.slice(0, 10).split("-").map(Number) as [number, number, number];
    checkedDate(y, mo, d, input);
    return { ms, dateOnly: false, date: localDateOf(ms, tz) };
  }

  const dOnly = DATE_ONLY.exec(text);
  if (dOnly) {
    const date = checkedDate(Number(dOnly[1]), Number(dOnly[2]), Number(dOnly[3]), input);
    return { ms: startOfLocalDay(date, tz), dateOnly: true, date };
  }

  const local = LOCAL_DATE_TIME.exec(text);
  if (local) {
    const date = checkedDate(Number(local[1]), Number(local[2]), Number(local[3]), input);
    const hour = Number(local[4]);
    const minute = Number(local[5]);
    const second = local[6] ? Number(local[6]) : 0;
    if (hour > 23 || minute > 59 || second > 59) throw invalid();
    return { ms: zonedToInstant({ ...date, hour, minute, second }, tz), dateOnly: false, date };
  }

  const keyword = /^(today|tomorrow|yesterday)(?:\s+(.+))?$/i.exec(text);
  const today = localDateOf(now, tz);
  if (keyword) {
    const shift = { today: 0, tomorrow: 1, yesterday: -1 }[keyword[1]!.toLowerCase() as "today"];
    const date = addDays(today, shift);
    if (!keyword[2]) return { ms: startOfLocalDay(date, tz), dateOnly: true, date };
    const clock = parseClock(keyword[2]);
    if (!clock) throw invalid();
    return { ms: zonedToInstant({ ...date, ...clock, second: 0 }, tz), dateOnly: false, date };
  }

  const clock = parseClock(text);
  if (clock) return { ms: zonedToInstant({ ...today, ...clock, second: 0 }, tz), dateOnly: false, date: today };

  throw invalid();
}

/**
 * Half-open range [start, end) from --from/--to/--date style inputs.
 * A date-only `to` is inclusive of that whole day; a date-time `to` is exclusive.
 */
export function parseRange(
  opts: { date?: string; from?: string; to?: string; days?: string },
  tz: string,
  now: number,
): { start: number; end: number } {
  if (opts.date && (opts.from || opts.to)) {
    throw new CliError("INVALID_ARGUMENT", "Use either --date or --from/--to, not both.");
  }
  const startInput = parseUserDate(opts.date ?? opts.from ?? "today", tz, now);
  const start = startInput.dateOnly ? startOfLocalDay(startInput.date, tz) : startInput.ms;
  let end: number;
  if (opts.days !== undefined) {
    if (opts.to || opts.date) throw new CliError("INVALID_ARGUMENT", "--days cannot be combined with --to or --date.");
    const n = parsePositiveInt(opts.days, "--days");
    end = startOfLocalDay(addDays(localDateOf(start, tz), n), tz);
  } else if (opts.to) {
    const toInput = parseUserDate(opts.to, tz, now);
    end = toInput.dateOnly ? startOfLocalDay(addDays(toInput.date, 1), tz) : toInput.ms;
  } else {
    end = startOfLocalDay(addDays(localDateOf(start, tz), 1), tz);
  }
  if (end <= start) throw new CliError("INVALID_ARGUMENT", "The range end must be after its start.");
  return { start, end };
}

export function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CliError("INVALID_ARGUMENT", `${flag} must be a positive integer.`);
  }
  return Number(value);
}

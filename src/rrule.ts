import { addDays, daysInMonth, localDateOf, zonedParts, zonedToInstant, type LocalDate } from "./time";

/**
 * Minimal RFC 5545 RRULE expansion for the rules TickTick produces.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (with ordinals for
 * MONTHLY/YEARLY), BYMONTHDAY (negative allowed), BYMONTH, UNTIL, COUNT, WKST.
 * Anything else (BYSETPOS, BYHOUR, BYWEEKNO, TickTick TT_* extensions, ...) is
 * reported as unsupported so callers can mark the series as unknown instead of guessing.
 *
 * Occurrences keep the anchor's wall-clock time in the task timezone, so DST
 * changes move the UTC instant, not the local time.
 */

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RRule {
  freq: Frequency;
  interval: number;
  byDay?: Array<{ weekday: number; ordinal?: number }>;
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number;
  /** Inclusive instant bound (UNTIL with a time). */
  untilMs?: number;
  /** Inclusive local-date bound (date-only UNTIL). */
  untilDate?: LocalDate;
  wkst: number;
}

export interface ParsedRule {
  rule?: RRule;
  unsupported: string[];
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FREQS: Frequency[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function intList(value: string, min: number, max: number, allowNegative: boolean): number[] | undefined {
  const nums = value.split(",").map((v) => Number(v));
  const ok = nums.every((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max && (allowNegative || n > 0));
  return ok ? nums : undefined;
}

export function parseRRule(flag: string): ParsedRule {
  const unsupported: string[] = [];
  const line = flag.split(/\r?\n/).find((l) => l.toUpperCase().startsWith("RRULE:")) ?? flag;
  const body = line.replace(/^RRULE:/i, "");
  const fields = new Map<string, string>();
  for (const part of body.split(";").filter(Boolean)) {
    const [key, value] = part.split("=");
    if (!key || value === undefined) {
      unsupported.push(part);
      continue;
    }
    fields.set(key.toUpperCase(), value.toUpperCase());
  }

  const freq = fields.get("FREQ") as Frequency | undefined;
  if (!freq || !FREQS.includes(freq)) return { unsupported: [`FREQ=${fields.get("FREQ") ?? "missing"}`] };
  const rule: RRule = { freq, interval: 1, wkst: 1 };

  for (const [key, value] of fields) {
    switch (key) {
      case "FREQ":
        break;
      case "INTERVAL": {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 1) rule.interval = n;
        else unsupported.push(`INTERVAL=${value}`);
        break;
      }
      case "BYDAY": {
        const days: NonNullable<RRule["byDay"]> = [];
        for (const d of value.split(",")) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
          if (!m) {
            unsupported.push(`BYDAY=${value}`);
            break;
          }
          const ordinal = m[1] ? Number(m[1]) : undefined;
          days.push({ weekday: DAY_CODES.indexOf(m[2]!), ...(ordinal ? { ordinal } : {}) });
        }
        rule.byDay = days;
        break;
      }
      case "BYMONTHDAY": {
        const days = intList(value, 1, 31, true);
        if (days) rule.byMonthDay = days;
        else unsupported.push(`BYMONTHDAY=${value}`);
        break;
      }
      case "BYMONTH": {
        const months = intList(value, 1, 12, false);
        if (months) rule.byMonth = months;
        else unsupported.push(`BYMONTH=${value}`);
        break;
      }
      case "COUNT": {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 1) rule.count = n;
        else unsupported.push(`COUNT=${value}`);
        break;
      }
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
        if (!m) unsupported.push(`UNTIL=${value}`);
        else if (m[4] === undefined) rule.untilDate = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
        else rule.untilMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
        break;
      }
      case "WKST": {
        const idx = DAY_CODES.indexOf(value);
        if (idx >= 0) rule.wkst = idx;
        else unsupported.push(`WKST=${value}`);
        break;
      }
      default:
        unsupported.push(`${key}=${value}`);
    }
  }

  const ordinals = rule.byDay?.some((d) => d.ordinal !== undefined);
  if (ordinals && (rule.freq === "DAILY" || rule.freq === "WEEKLY")) unsupported.push("BYDAY ordinals with DAILY/WEEKLY");
  if (rule.freq === "YEARLY" && rule.byDay && !rule.byMonth) unsupported.push("YEARLY BYDAY without BYMONTH");
  if (rule.freq === "WEEKLY" && rule.byMonthDay) unsupported.push("WEEKLY with BYMONTHDAY");
  return unsupported.length > 0 ? { unsupported } : { rule, unsupported };
}

const weekdayOf = (d: LocalDate) => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
const compare = (a: LocalDate, b: LocalDate) => a.year - b.year || a.month - b.month || a.day - b.day;

function monthDays(year: number, month: number, rule: RRule, anchorDay: number): LocalDate[] {
  const last = daysInMonth(year, month);
  const out: LocalDate[] = [];
  if (rule.byMonthDay) {
    for (const md of rule.byMonthDay) {
      const day = md > 0 ? md : last + md + 1;
      if (day >= 1 && day <= last) out.push({ year, month, day });
    }
  } else if (rule.byDay) {
    for (const { weekday, ordinal } of rule.byDay) {
      const matches: number[] = [];
      for (let day = 1; day <= last; day++) if (weekdayOf({ year, month, day }) === weekday) matches.push(day);
      if (ordinal === undefined) out.push(...matches.map((day) => ({ year, month, day })));
      else {
        const day = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal];
        if (day !== undefined) out.push({ year, month, day });
      }
    }
  } else if (anchorDay <= last) {
    out.push({ year, month, day: anchorDay });
  }
  return out;
}

/** Candidate local dates for the k-th period after the anchor. */
function periodDates(rule: RRule, anchor: LocalDate, k: number): LocalDate[] {
  switch (rule.freq) {
    case "DAILY": {
      const d = addDays(anchor, k * rule.interval);
      const dayOk = !rule.byDay || rule.byDay.some((b) => b.weekday === weekdayOf(d));
      const mdOk = !rule.byMonthDay || rule.byMonthDay.some((md) => (md > 0 ? md : daysInMonth(d.year, d.month) + md + 1) === d.day);
      return dayOk && mdOk ? [d] : [];
    }
    case "WEEKLY": {
      const weekStart = addDays(anchor, -((weekdayOf(anchor) - rule.wkst + 7) % 7) + 7 * rule.interval * k);
      const weekdays = rule.byDay ? rule.byDay.map((b) => b.weekday) : [weekdayOf(anchor)];
      return weekdays.map((wd) => addDays(weekStart, (wd - rule.wkst + 7) % 7));
    }
    case "MONTHLY": {
      const index = anchor.year * 12 + (anchor.month - 1) + k * rule.interval;
      return monthDays(Math.floor(index / 12), (index % 12) + 1, rule, anchor.day);
    }
    case "YEARLY": {
      const year = anchor.year + k * rule.interval;
      const months = rule.byMonth ?? [anchor.month];
      return months.flatMap((m) => (rule.byMonthDay || rule.byDay ? monthDays(year, m, rule, anchor.day) : anchor.day <= daysInMonth(year, m) ? [{ year, month: m, day: anchor.day }] : []));
    }
  }
}

const MAX_PERIODS = 20_000;

/**
 * Occurrence instants strictly after `anchorMs` and before `endMs`, at most `limit`.
 * Returns `truncated` when the limit stopped the expansion.
 */
export function expandAfter(rule: RRule, anchorMs: number, tz: string, endMs: number, limit: number): { instants: number[]; truncated: boolean } {
  const anchorDate = localDateOf(anchorMs, tz);
  const { hour, minute, second } = zonedParts(anchorMs, tz);
  // One spare day covers wall times that land after `endMs` in UTC terms.
  const lastDate = addDays(localDateOf(endMs, tz), 1);
  const instants: number[] = [];
  for (let k = 0; k < MAX_PERIODS; k++) {
    if (compare(approxPeriodStart(rule, anchorDate, k), lastDate) > 0) return { instants, truncated: false };
    const dates = periodDates(rule, anchorDate, k)
      .filter((d) => !rule.byMonth || rule.byMonth.includes(d.month))
      .sort(compare);
    for (const d of dates) {
      if (rule.untilDate && compare(d, rule.untilDate) > 0) return { instants, truncated: false };
      const ms = zonedToInstant({ ...d, hour, minute, second }, tz);
      if (rule.untilMs !== undefined && ms > rule.untilMs) return { instants, truncated: false };
      if (ms <= anchorMs || ms >= endMs) continue;
      if (instants.length >= limit) return { instants, truncated: true };
      instants.push(ms);
    }
  }
  return { instants, truncated: true };
}

/** Lower bound of the k-th period's first day, used to stop when periods produce no dates. */
function approxPeriodStart(rule: RRule, anchor: LocalDate, k: number): LocalDate {
  switch (rule.freq) {
    case "DAILY":
      return addDays(anchor, k * rule.interval);
    case "WEEKLY":
      return addDays(anchor, 7 * rule.interval * k - 6);
    case "MONTHLY": {
      const index = anchor.year * 12 + (anchor.month - 1) + k * rule.interval;
      return { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
    }
    case "YEARLY":
      return { year: anchor.year + k * rule.interval, month: 1, day: 1 };
  }
}

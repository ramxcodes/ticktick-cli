import { describe, expect, test } from "bun:test";
import { buildAgenda, classify } from "../src/agenda";
import { parseRange } from "../src/time";
import type { Task } from "../src/types";

const KOL = "Asia/Kolkata";
const NOW = Date.parse("2026-10-27T10:00:00Z");
let n = 0;
const t = (p: Partial<Task>): Task => ({ id: `t${++n}`.padStart(24, "0"), projectId: "p", title: `task ${n}`, status: 0, timeZone: KOL, ...p });
// Local Kolkata time to API format.
const at = (local: string) => new Date(Date.parse(`${local}:00+05:30`)).toISOString().replace("Z", "+0000");

function agenda(tasks: Task[], range: Parameters<typeof parseRange>[0] = { date: "2026-10-28" }) {
  const r = parseRange(range, KOL, NOW);
  const warnings: string[] = [];
  const a = buildAgenda(tasks.map((task) => ({ task, projectName: "P" })), r.start, r.end, KOL, (w) => warnings.push(w));
  return { ...a, warnings };
}

describe("classify", () => {
  test("start < due is an interval, start == due a point, due only a deadline", () => {
    expect(classify(t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:15") }), KOL).kind).toBe("interval");
    expect(classify(t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:00") }), KOL).kind).toBe("point");
    expect(classify(t({ dueDate: at("2026-10-28T12:00") }), KOL).kind).toBe("deadline");
    expect(classify(t({}), KOL).kind).toBe("unscheduled");
  });
  test("start after due, or a malformed date, is invalid", () => {
    expect(classify(t({ startDate: at("2026-10-28T13:00"), dueDate: at("2026-10-28T12:00") }), KOL)).toMatchObject({ kind: "invalid" });
    expect(classify(t({ dueDate: "tomorrow" }), KOL)).toMatchObject({ kind: "invalid" });
  });
  test("all-day: equal dates are one day, a later midnight due is an exclusive end", () => {
    const one = classify(t({ isAllDay: true, startDate: at("2026-10-28T00:00"), dueDate: at("2026-10-28T00:00") }), KOL);
    expect(one.days).toEqual({ first: { year: 2026, month: 10, day: 28 }, afterLast: { year: 2026, month: 10, day: 29 } });
    const two = classify(t({ isAllDay: true, startDate: at("2026-11-04T00:00"), dueDate: at("2026-11-06T00:00") }), KOL);
    expect(two.days?.afterLast).toEqual({ year: 2026, month: 11, day: 6 });
  });
});

describe("buildAgenda", () => {
  test("12:00-12:15 meeting and an 11:00-12:00 task do not overlap", () => {
    const a = agenda([t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:15") }), t({ startDate: at("2026-10-28T11:00"), dueDate: at("2026-10-28T12:00") })]);
    expect(a.conflicts).toEqual([]);
    expect(a.busy).toEqual([
      { start: "2026-10-28T11:00:00+05:30", end: "2026-10-28T12:00:00+05:30" },
      { start: "2026-10-28T12:00:00+05:30", end: "2026-10-28T12:15:00+05:30" },
    ]);
  });
  test("overlapping intervals are reported and merged into busy time", () => {
    const a = agenda([t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T13:00") }), t({ startDate: at("2026-10-28T12:30"), dueDate: at("2026-10-28T14:00") })]);
    expect(a.conflicts).toHaveLength(1);
    expect(a.conflicts[0]).toMatchObject({ overlapStart: "2026-10-28T12:30:00+05:30", overlapEnd: "2026-10-28T13:00:00+05:30" });
    expect(a.busy).toEqual([{ start: "2026-10-28T12:00:00+05:30", end: "2026-10-28T14:00:00+05:30" }]);
  });
  test("deadlines, points, and all-day tasks never block time", () => {
    const a = agenda([
      t({ dueDate: at("2026-10-28T12:00") }),
      t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:00") }),
      t({ isAllDay: true, startDate: at("2026-10-28T00:00"), dueDate: at("2026-10-28T00:00") }),
    ]);
    expect(a.entries.map((e) => [e.kind, e.blocksTime])).toEqual([["all-day", false], ["deadline", false], ["point", false]]);
    expect(a.busy).toEqual([]);
  });
  test("a cross-midnight interval appears on both days", () => {
    const night = t({ startDate: at("2026-10-27T23:00"), dueDate: at("2026-10-28T01:00") });
    expect(agenda([night], { date: "2026-10-27" }).entries).toHaveLength(1);
    expect(agenda([night], { date: "2026-10-28" }).entries).toHaveLength(1);
    expect(agenda([night], { date: "2026-10-29" }).entries).toHaveLength(0);
  });
  test("an interval ending exactly at the range start is excluded (half-open)", () => {
    expect(agenda([t({ startDate: at("2026-10-27T23:00"), dueDate: at("2026-10-28T00:00") })]).entries).toHaveLength(0);
  });
  test("invalid and unscheduled tasks are reported, not placed", () => {
    const a = agenda([t({ startDate: at("2026-10-28T13:00"), dueDate: at("2026-10-28T12:00") }), t({})]);
    expect(a.entries).toEqual([]);
    expect(a.invalid).toHaveLength(1);
    expect(a.unscheduledCount).toBe(1);
  });
  test("recurring series: server occurrence first, calculated ones marked", () => {
    const meeting = t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:15"), repeatFlag: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" });
    const a = agenda([meeting], { from: "2026-10-28", to: "2026-11-02" });
    expect(a.entries.map((e) => [e.start?.slice(0, 10), e.occurrence?.source])).toEqual([
      ["2026-10-28", "server"],
      ["2026-10-29", "calculated"],
      ["2026-10-30", "calculated"],
      ["2026-11-02", "calculated"],
    ]);
    expect(a.recurrence.calculatedOccurrences).toBe(3);
    expect(a.warnings.some((w) => w.includes("calculated"))).toBe(true);
  });
  test("a completed occurrence does not stop the series", () => {
    const series = t({ startDate: at("2026-10-29T12:00"), dueDate: at("2026-10-29T12:15"), repeatFlag: "RRULE:FREQ=DAILY" });
    const done = t({ startDate: at("2026-10-28T12:00"), dueDate: at("2026-10-28T12:15"), status: 2, completedTime: at("2026-10-28T12:20") });
    const a = agenda([series, done], { from: "2026-10-28", to: "2026-10-30" });
    expect(a.entries.map((e) => [e.start?.slice(0, 10), e.status, e.occurrence?.source ?? null])).toEqual([
      ["2026-10-28", "completed", null],
      ["2026-10-29", "open", "server"],
      ["2026-10-30", "open", "calculated"],
    ]);
  });
  test("rules that cannot be expanded are listed, not guessed", () => {
    const a = agenda([
      t({ dueDate: at("2026-10-28T09:00"), repeatFlag: "RRULE:FREQ=DAILY;COUNT=5" }),
      t({ dueDate: at("2026-10-28T09:00"), repeatFlag: "RRULE:FREQ=DAILY", repeatFrom: "1" }),
      t({ dueDate: at("2026-10-28T09:00"), repeatFlag: "RRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO" }),
    ], { from: "2026-10-28", to: "2026-11-30" });
    expect(a.recurrence.unsupportedSeries.map((s) => s.reason.split(":")[0])).toEqual([
      "COUNT rules",
      "repeats from completion date",
      "unsupported rule parts",
    ]);
    expect(a.entries.every((e) => e.occurrence?.source === "server")).toBe(true);
  });
  test("all-day recurring occurrences keep their date span", () => {
    const a = agenda([t({ isAllDay: true, startDate: at("2026-10-28T00:00"), dueDate: at("2026-10-28T00:00"), repeatFlag: "RRULE:FREQ=WEEKLY" })], { from: "2026-10-28", to: "2026-11-11" });
    expect(a.entries.map((e) => e.startDay)).toEqual(["2026-10-28", "2026-11-04", "2026-11-11"]);
  });
});

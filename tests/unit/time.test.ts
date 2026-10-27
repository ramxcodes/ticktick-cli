import { describe, expect, test } from "bun:test";
import { formatApiDate, formatIso, parseApiDate, parseRange, parseUserDate, zonedToInstant } from "../../src/time";

const NOW = Date.parse("2026-10-27T10:00:00Z"); // 15:30 in Kolkata
const KOL = "Asia/Kolkata";
const NY = "America/New_York";

describe("parseApiDate", () => {
  test("accepts TickTick formats with and without milliseconds or colon", () => {
    expect(parseApiDate("2026-10-28T06:30:00.000+0000")).toBe(Date.parse("2026-10-28T06:30:00Z"));
    expect(parseApiDate("2026-10-28T12:00:00+05:30")).toBe(Date.parse("2026-10-28T06:30:00Z"));
    expect(parseApiDate("2026-10-28T06:30:00Z")).toBe(Date.parse("2026-10-28T06:30:00Z"));
  });
  test("distinguishes empty from malformed", () => {
    expect(parseApiDate("")).toBeUndefined();
    expect(parseApiDate(undefined)).toBeUndefined();
    expect(parseApiDate("not-a-date")).toBeNull();
  });
  test("formatApiDate round-trips", () => {
    expect(parseApiDate(formatApiDate(NOW))).toBe(NOW);
  });
});

describe("parseUserDate", () => {
  test("local date-time is interpreted in the given zone", () => {
    expect(parseUserDate("2026-10-29T12:00", KOL, NOW).ms).toBe(Date.parse("2026-10-29T06:30:00Z"));
    expect(parseUserDate("2026-10-29 12:00", NY, NOW).ms).toBe(Date.parse("2026-10-29T16:00:00Z"));
  });
  test("explicit offsets win over the zone", () => {
    expect(parseUserDate("2026-10-29T12:00:00Z", KOL, NOW).ms).toBe(Date.parse("2026-10-29T12:00:00Z"));
  });
  test("keywords and bare times use the zone's today", () => {
    const tomorrow9 = parseUserDate("tomorrow 9am", KOL, NOW);
    expect(formatIso(tomorrow9.ms, KOL)).toBe("2026-10-28T09:00:00+05:30");
    expect(parseUserDate("today", KOL, NOW)).toMatchObject({ dateOnly: true, date: { year: 2026, month: 10, day: 27 } });
    expect(formatIso(parseUserDate("14:30", KOL, NOW).ms, KOL)).toBe("2026-10-27T14:30:00+05:30");
  });
  test("rejects impossible or unknown values instead of guessing", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "25:00", "next week", "2026-10-29T24:00", ""]) {
      expect(() => parseUserDate(bad, KOL, NOW)).toThrow();
    }
  });
});

describe("DST handling", () => {
  test("a wall time in the spring-forward gap moves forward", () => {
    const ms = zonedToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, NY);
    expect(formatIso(ms, NY)).toBe("2026-03-08T03:30:00-04:00");
  });
  test("an ambiguous fall-back wall time resolves to the earlier instant", () => {
    const ms = zonedToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, NY);
    expect(formatIso(ms, NY)).toBe("2026-11-01T01:30:00-04:00");
  });
  test("a day across fall-back is 25 hours long", () => {
    const r = parseRange({ date: "2026-11-01" }, NY, NOW);
    expect((r.end - r.start) / 3_600_000).toBe(25);
  });
});

describe("parseRange", () => {
  test("default is today in the zone, half-open", () => {
    const r = parseRange({}, KOL, NOW);
    expect(formatIso(r.start, KOL)).toBe("2026-10-27T00:00:00+05:30");
    expect(formatIso(r.end, KOL)).toBe("2026-10-28T00:00:00+05:30");
  });
  test("a date-only --to includes that whole day; a date-time --to is exclusive", () => {
    expect(formatIso(parseRange({ from: "2026-10-29", to: "2026-11-05" }, KOL, NOW).end, KOL)).toBe("2026-11-06T00:00:00+05:30");
    expect(formatIso(parseRange({ from: "2026-10-29T09:00", to: "2026-10-29T17:00" }, KOL, NOW).end, KOL)).toBe("2026-10-29T17:00:00+05:30");
  });
  test("--days counts calendar days", () => {
    const r = parseRange({ from: "2026-10-29", days: "7" }, KOL, NOW);
    expect(formatIso(r.end, KOL)).toBe("2026-11-05T00:00:00+05:30");
  });
  test("rejects empty or conflicting ranges", () => {
    expect(() => parseRange({ from: "2026-10-29", to: "2026-10-28" }, KOL, NOW)).toThrow();
    expect(() => parseRange({ date: "2026-10-29", from: "2026-10-28" }, KOL, NOW)).toThrow();
    expect(() => parseRange({ days: "0" }, KOL, NOW)).toThrow();
  });
});

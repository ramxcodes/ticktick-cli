import { describe, expect, test } from "bun:test";
import { expandAfter, parseRRule } from "../../src/rrule";
import { formatIso, zonedToInstant } from "../../src/time";

const KOL = "Asia/Kolkata";
const NY = "America/New_York";

function expand(flag: string, anchorLocal: string, endLocal: string, tz = KOL, limit = 100) {
  const parse = (s: string) => {
    const [d, t = "00:00"] = s.split("T");
    const [year, month, day] = d!.split("-").map(Number) as [number, number, number];
    const [hour, minute] = t.split(":").map(Number) as [number, number];
    return zonedToInstant({ year, month, day, hour, minute, second: 0 }, tz);
  };
  const { rule, unsupported } = parseRRule(flag);
  expect(unsupported).toEqual([]);
  return expandAfter(rule!, parse(anchorLocal), tz, parse(endLocal), limit).instants.map((ms) => formatIso(ms, tz).slice(0, 16));
}

describe("parseRRule", () => {
  test("parses TickTick rules", () => {
    expect(parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR").rule).toMatchObject({ freq: "WEEKLY", interval: 1 });
  });
  test("reports what it cannot expand instead of guessing", () => {
    expect(parseRRule("RRULE:FREQ=HOURLY").rule).toBeUndefined();
    expect(parseRRule("RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU").unsupported).toContain("BYSETPOS=-1");
    expect(parseRRule("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY").unsupported).toEqual(["TT_SKIP=HOLIDAY"]);
    expect(parseRRule("RRULE:FREQ=DAILY;BYDAY=XX").rule).toBeUndefined();
  });
});

describe("expandAfter", () => {
  test("daily, strictly after the anchor and before the end", () => {
    expect(expand("RRULE:FREQ=DAILY;INTERVAL=1", "2026-10-27T20:00", "2026-10-30T00:00")).toEqual(["2026-10-28T20:00", "2026-10-29T20:00"]);
  });
  test("weekday meeting skips weekends", () => {
    // 2026-10-30 is a Friday.
    expect(expand("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-10-30T12:00", "2026-11-04T00:00")).toEqual(["2026-11-02T12:00", "2026-11-03T12:00"]);
  });
  test("every second week on the anchor weekday", () => {
    expect(expand("RRULE:FREQ=WEEKLY;INTERVAL=2", "2026-11-02T09:00", "2026-12-01T00:00")).toEqual(["2026-11-16T09:00", "2026-11-30T09:00"]);
  });
  test("monthly on the 31st skips short months", () => {
    expect(expand("RRULE:FREQ=MONTHLY;BYMONTHDAY=31", "2026-01-31T08:00", "2026-06-01T00:00")).toEqual(["2026-03-31T08:00", "2026-05-31T08:00"]);
  });
  test("monthly on the last Friday", () => {
    expect(expand("RRULE:FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30T10:00", "2027-01-01T00:00")).toEqual(["2026-11-27T10:00", "2026-12-25T10:00"]);
  });
  test("yearly on Feb 29 only in leap years", () => {
    expect(expand("RRULE:FREQ=YEARLY", "2028-02-29T07:00", "2033-01-01T00:00")).toEqual(["2032-02-29T07:00"]);
  });
  test("UNTIL stops the series (inclusive)", () => {
    expect(expand("RRULE:FREQ=DAILY;UNTIL=20261029T143000Z", "2026-10-27T20:00", "2026-11-05T00:00")).toEqual(["2026-10-28T20:00", "2026-10-29T20:00"]);
    expect(expand("RRULE:FREQ=DAILY;UNTIL=20261028", "2026-10-27T20:00", "2026-11-05T00:00")).toEqual(["2026-10-28T20:00"]);
  });
  test("keeps the local time across a DST change", () => {
    expect(expand("RRULE:FREQ=DAILY", "2026-10-31T09:00", "2026-11-03T00:00", NY)).toEqual(["2026-11-01T09:00", "2026-11-02T09:00"]);
  });
  test("reports truncation at the limit", () => {
    const { rule } = parseRRule("RRULE:FREQ=DAILY");
    const anchor = Date.parse("2026-01-01T00:00:00Z");
    expect(expandAfter(rule!, anchor, "UTC", anchor + 100 * 86_400_000, 10)).toMatchObject({ truncated: true });
  });
});

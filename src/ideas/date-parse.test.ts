import { describe, expect, it } from "vitest";

import {
  describeDate,
  isIsoDate,
  parseSpokenDate,
  stripPhrase,
  wallClock,
  zonedIso,
} from "./date-parse.js";

const TZ = "Asia/Bangkok"; // owner: UTC+7
// Wed 14 Oct 2026, 10:00 in Bangkok (03:00 UTC).
const now = new Date(Date.UTC(2026, 9, 14, 3, 0, 0));
const parse = (text: string, extra: Record<string, unknown> = {}) =>
  parseSpokenDate(text, { now, timeZone: TZ, ...extra });

describe("parseSpokenDate", () => {
  it.each([
    ["call the bank tomorrow", "2026-10-15"],
    ["ship it by Friday", "2026-10-16"],
    ["this Friday", "2026-10-16"],
    ["next Tuesday", "2026-10-20"], // Tuesday of next week
    ["next Friday", "2026-10-23"],
    ["on Wednesday", "2026-10-21"], // a weekday named today means next week's
    ["in two weeks", "2026-10-28"],
    ["in 3 days", "2026-10-17"],
    ["within a few days", "2026-10-17"],
    ["in a fortnight", "2026-10-28"],
    ["2 weeks from now", "2026-10-28"],
    ["in a month", "2026-11-14"],
    ["by end of month", "2026-10-31"],
    ["by the end of next month", "2026-11-30"],
    ["end of the week", "2026-10-16"],
    ["end of next week", "2026-10-23"],
    ["this weekend", "2026-10-17"],
    ["next weekend", "2026-10-24"],
    ["next week", "2026-10-19"],
    ["next month", "2026-11-01"],
    ["day after tomorrow", "2026-10-16"],
    ["file taxes on October 20th", "2026-10-20"],
    ["Oct 17", "2026-10-17"],
    ["the 30th of october", "2026-10-30"],
    ["17 October 2027", "2027-10-17"],
    ["by the 30th", "2026-10-30"],
    ["by the 3rd", "2026-11-03"], // passed this month → next month
    ["due 2026-12-01", "2026-12-01"],
    ["by 17/11", "2026-11-17"], // day first
    ["renew in January 5", "2027-01-05"],
    ["by end of year", "2026-12-31"],
  ])("%s → %s", (text, date) => {
    expect(parse(text)?.date).toBe(date);
  });

  it("returns the phrase it came from", () => {
    expect(parse("ship the deck by Friday please")).toMatchObject({
      date: "2026-10-16",
      phrase: "by Friday",
    });
  });

  it("attaches a spoken time", () => {
    expect(parse("call Gengu next Tuesday at 3")).toMatchObject({
      date: "2026-10-20",
      time: "15:00",
      phrase: "next Tuesday at 3",
    });
    expect(parse("demo on Friday at 10:30am")).toMatchObject({ date: "2026-10-16", time: "10:30" });
    expect(parse("standup at 9 tomorrow")).toMatchObject({ date: "2026-10-15", time: "09:00" });
    expect(parse("tomorrow morning")).toMatchObject({ date: "2026-10-15", time: "09:00" });
    expect(parse("Oct 17 at 15:45")).toMatchObject({ date: "2026-10-17", time: "15:45" });
    expect(parse("lunch with Alan tomorrow at noon")).toMatchObject({ time: "12:00" });
    expect(parse("in 2 hours")).toMatchObject({ date: "2026-10-14", time: "12:00" });
  });

  it("a time with no date is today, or tomorrow once it has passed", () => {
    expect(parse("call mum at 6pm")).toMatchObject({ date: "2026-10-14", time: "18:00" });
    expect(parse("call mum at 8am")).toMatchObject({ date: "2026-10-15", time: "08:00" });
  });

  it("does not read numbers and ordinary words as dates", () => {
    expect(parse("no deadline here")).toBeNull();
    expect(parse("we sat at 3 locations")).toBeNull();
    expect(parse("finish 3/4 of the deck")).toBeNull();
    expect(parse("I wed the code to the sun")).toBeNull();
  });

  it("prefers the phrase with a deadline cue", () => {
    expect(parse("talked Monday, ship it by Friday")?.date).toBe("2026-10-16");
  });

  it("past dates only when allowed (logs)", () => {
    expect(parse("the render finished yesterday")).toBeNull();
    expect(parse("the render finished yesterday", { allowPast: true })?.date).toBe("2026-10-13");
    expect(parse("met Alan last Friday", { allowPast: true })?.date).toBe("2026-10-09");
  });

  it("requireCue keeps notes from grabbing an incidental weekday", () => {
    expect(parse("Friday's meeting went well", { requireCue: true })).toBeNull();
    expect(parse("review this next week", { requireCue: true })?.date).toBe("2026-10-19");
    expect(parse("revisit on the 20th", { requireCue: true })?.date).toBe("2026-10-20");
  });

  it("uses the owner's timezone, not the host clock", () => {
    // 23:30 UTC on 14 Oct is already 15 Oct 06:30 in Bangkok.
    const late = new Date(Date.UTC(2026, 9, 14, 23, 30));
    expect(parseSpokenDate("tomorrow", { now: late, timeZone: TZ })?.date).toBe("2026-10-16");
    expect(parseSpokenDate("tomorrow", { now: late, timeZone: "America/New_York" })?.date).toBe(
      "2026-10-15",
    );
    expect(wallClock(late, TZ)).toMatchObject({ y: 2026, m: 10, d: 15, hour: 6, weekday: 4 });
    // Bad zone → host zone, never a throw.
    expect(parseSpokenDate("tomorrow", { now: late, timeZone: "Mars/Olympus" })).not.toBeNull();
  });

  it("handles month and year rollovers", () => {
    const dec = new Date(Date.UTC(2026, 11, 30, 3)); // Wed 30 Dec 2026, Bangkok
    expect(parseSpokenDate("in 3 days", { now: dec, timeZone: TZ })?.date).toBe("2027-01-02");
    expect(parseSpokenDate("next month", { now: dec, timeZone: TZ })?.date).toBe("2027-01-01");
    expect(parseSpokenDate("Jan 4", { now: dec, timeZone: TZ })?.date).toBe("2027-01-04");
    const jan31 = new Date(Date.UTC(2026, 0, 31, 3));
    expect(parseSpokenDate("in a month", { now: jan31, timeZone: TZ })?.date).toBe("2026-02-28");
  });
});

describe("helpers", () => {
  it("stripPhrase removes the date words cleanly", () => {
    const text = "ship it by Friday, it's urgent";
    const hit = parse(text)!;
    expect(stripPhrase(text, hit)).toBe("ship it, it's urgent");
  });

  it("describeDate is human readable", () => {
    expect(describeDate("2026-10-16", undefined, { now, timeZone: TZ })).toBe("Fri 16 Oct");
    expect(describeDate("2026-10-17", "15:00", { now, timeZone: TZ })).toBe("Sat 17 Oct, 3 pm");
    expect(describeDate("2027-01-05", "09:30", { now, timeZone: TZ })).toBe(
      "Tue 5 Jan 2027, 9:30 am",
    );
  });

  it("isIsoDate rejects impossible dates", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("soon")).toBe(false);
  });

  it("zonedIso carries the zone offset", () => {
    expect(zonedIso("2026-10-17", "15:00", TZ)).toBe("2026-10-17T15:00:00+07:00");
    expect(zonedIso("2026-07-01", "09:00", "America/New_York")).toBe("2026-07-01T09:00:00-04:00");
  });
});

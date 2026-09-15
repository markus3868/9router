import { describe, it, expect } from "vitest";
import {
  API_KEY_SCHEDULE_MODES,
  computeApiKeyIsActive,
  formatVietnamDateTime,
  getVietnamDateKey,
  getVietnamStartOfDay,
  getNextVietnamBusinessStartAfter,
  getNextVietnamScheduleTransition,
  isVietnamBusinessHours,
  isVietnamBusinessWeekday,
} from "@/lib/apiKeys/schedule.js";

describe("API key schedule", () => {
  it("treats 08:00-18:29 Vietnam time as active", () => {
    expect(isVietnamBusinessHours(new Date("2026-05-22T01:00:00.000Z"))).toBe(true);
    expect(isVietnamBusinessHours(new Date("2026-05-22T11:29:59.000Z"))).toBe(true);
  });

  it("treats before 08:00 and from 18:30 as inactive", () => {
    expect(isVietnamBusinessHours(new Date("2026-05-22T00:59:59.000Z"))).toBe(false);
    expect(isVietnamBusinessHours(new Date("2026-05-22T11:30:00.000Z"))).toBe(false);
  });

  it("treats Saturday and Sunday as inactive all day", () => {
    expect(isVietnamBusinessWeekday(new Date("2026-05-23T03:00:00.000Z"))).toBe(false);
    expect(isVietnamBusinessHours(new Date("2026-05-23T03:00:00.000Z"))).toBe(false);
    expect(isVietnamBusinessHours(new Date("2026-05-24T08:00:00.000Z"))).toBe(false);
  });

  it("bypasses working-hour schedule when the feature is disabled", () => {
    const key = {
      scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
    };
    expect(computeApiKeyIsActive(key, new Date("2026-05-23T03:00:00.000Z"), {
      workingHoursEnabled: false,
    })).toBe(true);
  });

  it("keeps manual and temporary disables effective when working hours are disabled", () => {
    const now = new Date("2026-05-23T03:00:00.000Z");
    expect(computeApiKeyIsActive({
      scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
      manualDisabled: true,
    }, now, { workingHoursEnabled: false })).toBe(false);
    expect(computeApiKeyIsActive({
      scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
      temporaryDisabledUntil: "2026-05-24T00:00:00.000Z",
    }, now, { workingHoursEnabled: false })).toBe(false);
  });

  it("lets manual disable override schedule", () => {
    const key = {
      scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
      manualDisabled: true,
    };
    expect(computeApiKeyIsActive(key, new Date("2026-05-22T01:30:00.000Z"))).toBe(false);
  });

  it("lets temporary disable override schedule until its deadline", () => {
    const key = {
      scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
      temporaryDisabledUntil: "2026-05-25T01:00:00.000Z",
    };
    expect(computeApiKeyIsActive(key, new Date("2026-05-22T02:00:00.000Z"))).toBe(false);
    expect(computeApiKeyIsActive(key, new Date("2026-05-25T01:00:00.000Z"))).toBe(true);
  });

  it("computes next schedule transition in Vietnam time", () => {
    expect(getNextVietnamScheduleTransition(new Date("2026-05-22T00:00:00.000Z")).toISOString())
      .toBe("2026-05-22T01:00:00.000Z");
    expect(getNextVietnamScheduleTransition(new Date("2026-05-22T01:30:00.000Z")).toISOString())
      .toBe("2026-05-22T11:30:00.000Z");
    expect(getNextVietnamScheduleTransition(new Date("2026-05-22T12:00:00.000Z")).toISOString())
      .toBe("2026-05-25T01:00:00.000Z");
    expect(getNextVietnamScheduleTransition(new Date("2026-05-23T03:00:00.000Z")).toISOString())
      .toBe("2026-05-25T01:00:00.000Z");
    expect(getNextVietnamScheduleTransition(new Date("2026-05-24T12:00:00.000Z")).toISOString())
      .toBe("2026-05-25T01:00:00.000Z");
  });

  it("computes next business-day 08:00 for temporary disable", () => {
    expect(getNextVietnamBusinessStartAfter(new Date("2026-05-21T04:00:00.000Z")).toISOString())
      .toBe("2026-05-22T01:00:00.000Z");
    expect(getNextVietnamBusinessStartAfter(new Date("2026-05-22T04:00:00.000Z")).toISOString())
      .toBe("2026-05-25T01:00:00.000Z");
  });

  it("computes Vietnam date keys and start-of-day boundaries", () => {
    const now = new Date("2026-05-22T17:45:30.000Z");
    expect(getVietnamDateKey(now)).toBe("2026-05-23");
    expect(getVietnamStartOfDay(now).toISOString()).toBe("2026-05-22T17:00:00.000Z");
    expect(getVietnamStartOfDay(now, 6).toISOString()).toBe("2026-05-16T17:00:00.000Z");
  });

  it("formats Vietnam timestamps in plain text", () => {
    expect(formatVietnamDateTime(new Date("2026-05-22T01:05:09.000Z")))
      .toBe("2026-05-22 08:05:09 Asia/Ho_Chi_Minh");
  });
});

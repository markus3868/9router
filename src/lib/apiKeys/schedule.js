export const API_KEY_SOURCES = {
  MANUAL: "manual",
  TELEGRAM: "telegram",
};

export const API_KEY_SCHEDULE_MODES = {
  NONE: "none",
  VN_BUSINESS_HOURS: "vn-business-hours",
};

export const VIETNAM_TIMEZONE = "Asia/Ho_Chi_Minh";

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const ACTIVE_START_MINUTES = 8 * 60;
const ACTIVE_END_MINUTES = 18 * 60 + 30;

export function getVietnamLocalParts(now = new Date()) {
  const shifted = new Date(now.getTime() + VIETNAM_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
  };
}

export function getVietnamDateKey(now = new Date()) {
  const parts = getVietnamLocalParts(now);
  return `${parts.year}-${String(parts.month + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function getVietnamStartOfDay(now = new Date(), daysBack = 0) {
  const parts = getVietnamLocalParts(now);
  const shiftedUtcMs = Date.UTC(
    parts.year,
    parts.month,
    parts.day - daysBack,
    0,
    0,
    0,
    0
  );
  return new Date(shiftedUtcMs - VIETNAM_OFFSET_MS);
}

export function formatVietnamDateTime(now = new Date()) {
  const parts = getVietnamLocalParts(now);
  return `${parts.year}-${String(parts.month + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hours).padStart(2, "0")}:${String(parts.minutes).padStart(2, "0")}:${String(parts.seconds).padStart(2, "0")} ${VIETNAM_TIMEZONE}`;
}

export function isVietnamBusinessWeekday(now = new Date()) {
  const { dayOfWeek } = getVietnamLocalParts(now);
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

function buildVietnamDate(parts, dayOffset, hours, minutes) {
  const shiftedUtcMs = Date.UTC(
    parts.year,
    parts.month,
    parts.day + dayOffset,
    hours,
    minutes,
    0,
    0
  );
  return new Date(shiftedUtcMs - VIETNAM_OFFSET_MS);
}

export function isVietnamBusinessHours(now = new Date()) {
  const { hours, minutes } = getVietnamLocalParts(now);
  if (!isVietnamBusinessWeekday(now)) return false;
  const totalMinutes = hours * 60 + minutes;
  return totalMinutes >= ACTIVE_START_MINUTES && totalMinutes < ACTIVE_END_MINUTES;
}

export function isScheduleActive(scheduleMode, now = new Date(), options = {}) {
  if (!scheduleMode || scheduleMode === API_KEY_SCHEDULE_MODES.NONE) return true;
  if (scheduleMode === API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS) {
    if (options.workingHoursEnabled === false) return true;
    return isVietnamBusinessHours(now);
  }
  return true;
}

export function computeApiKeyIsActive(apiKey, now = new Date(), options = {}) {
  const manualDisabled = apiKey?.manualDisabled === true;
  if (manualDisabled) return false;
  if (apiKey?.temporaryDisabledUntil) {
    const disabledUntilMs = new Date(apiKey.temporaryDisabledUntil).getTime();
    if (Number.isFinite(disabledUntilMs) && now.getTime() < disabledUntilMs) return false;
  }
  return isScheduleActive(apiKey?.scheduleMode, now, options);
}

export function getNextVietnamScheduleTransition(now = new Date()) {
  const parts = getVietnamLocalParts(now);
  const totalMinutes = parts.hours * 60 + parts.minutes;
  const isWeekday = parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5;

  if (isWeekday && totalMinutes >= ACTIVE_START_MINUTES && totalMinutes < ACTIVE_END_MINUTES) {
    return buildVietnamDate(parts, 0, 18, 30);
  }

  let dayOffset = isWeekday && totalMinutes < ACTIVE_START_MINUTES ? 0 : 1;
  while (true) {
    const candidate = buildVietnamDate(parts, dayOffset, 0, 0);
    if (isVietnamBusinessWeekday(candidate)) {
      return buildVietnamDate(parts, dayOffset, 8, 0);
    }
    dayOffset += 1;
  }
}

export function getNextVietnamBusinessStartAfter(now = new Date()) {
  const parts = getVietnamLocalParts(now);
  let dayOffset = 1;
  while (true) {
    const candidate = buildVietnamDate(parts, dayOffset, 8, 0);
    if (isVietnamBusinessWeekday(candidate)) return candidate;
    dayOffset += 1;
  }
}

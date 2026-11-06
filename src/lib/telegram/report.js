import { getProviderConnections } from "@/lib/localDb";
import { getTelegramReportUsageSummary } from "./reportUsage.js";
import {
  getVietnamStartOfDay,
  isVietnamBusinessWeekday,
} from "@/lib/apiKeys/schedule.js";
import { fetchUsageForConnection, isUsageEligibleConnection } from "@/lib/usage/connectionUsage.js";
import {
  formatResetTime,
  getRemainingPercentage,
  parseQuotaData,
} from "@/lib/usage/quotaUtils.js";

const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTA_FETCH_TIMEOUT_MS = 15 * 1000;
const QUOTA_LOW_THRESHOLD = 30;
const QUOTA_DEPLETED_THRESHOLD = 5;
const TOP_LOW_QUOTAS_LIMIT = 5;
const WORKWEEK_DAYS = 5;
const WORKDAY_BURN_PERCENT = 100 / WORKWEEK_DAYS;
const QUOTA_BUFFER_PERCENT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_END_OFFSET_MS = (18 * 60 + 30) * 60 * 1000;

const g = global.__telegramReportRuntime ??= {
  quotaSnapshot: null,
  quotaSnapshotExpiresAt: 0,
  quotaSnapshotPromise: null,
};

function formatInteger(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatSharePercentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "0$";

  const precision = amount >= 100 ? 0 : amount >= 1 ? 2 : 4;
  const formatted = amount.toFixed(precision).replace(/\.?0+$/, "");
  return `${formatted}$`;
}

function isEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getConnectionLabel(connection) {
  if (isEmail(connection.email)) return connection.email;
  if (isEmail(connection.name)) return connection.name;
  if (typeof connection.name === "string" && connection.name.trim()) return connection.name.trim();
  return connection.id?.slice(0, 8) || "unknown";
}

function getQuotaStatus(remaining) {
  if (remaining <= QUOTA_DEPLETED_THRESHOLD) return "depleted";
  if (remaining < QUOTA_LOW_THRESHOLD) return "low";
  return "ok";
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isWeeklyQuota(quotaName) {
  return typeof quotaName === "string" && quotaName.toLowerCase().includes("week");
}

function countFutureVietnamBusinessDays(resetAt, now = new Date()) {
  const resetDate = resetAt instanceof Date ? resetAt : new Date(resetAt);
  if (Number.isNaN(resetDate.getTime()) || resetDate <= now) return 0;

  let count = 0;
  let cursor = new Date(getVietnamStartOfDay(now).getTime() + DAY_MS);

  while (cursor < resetDate) {
    if (isVietnamBusinessWeekday(cursor)) {
      const businessEnd = new Date(cursor.getTime() + BUSINESS_END_OFFSET_MS);
      if (businessEnd <= resetDate) count += 1;
    }
    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  return count;
}

function getAdjustedWorkdayQuotaRemaining(rawRemaining, quotaName, resetAt, now = new Date()) {
  if (!Number.isFinite(rawRemaining) || !isWeeklyQuota(quotaName)) {
    return { remaining: rawRemaining, isAdjusted: false };
  }

  if (!isVietnamBusinessWeekday(now)) {
    return { remaining: 0, isAdjusted: true };
  }

  const futureWorkdays = countFutureVietnamBusinessDays(resetAt, now);
  const requiredFloor = Math.min(100, futureWorkdays * WORKDAY_BURN_PERCENT);
  const todayBudgetRemaining = ((rawRemaining - requiredFloor) / WORKDAY_BURN_PERCENT) * 100;
  const clampedTodayBudgetRemaining = Math.max(0, Math.min(100, todayBudgetRemaining));
  const bufferedRemaining = Math.max(0, Math.round(clampedTodayBudgetRemaining - QUOTA_BUFFER_PERCENT));

  return { remaining: bufferedRemaining, isAdjusted: true };
}

function summarizeQuotaConnection(connection, data, error = null, now = new Date()) {
  if (error) {
    return {
      connectionId: connection.id,
      provider: connection.provider,
      label: `${connection.provider} / ${getConnectionLabel(connection)}`,
      status: "unavailable",
      remaining: null,
      quotaName: null,
      resetAt: null,
      resetIn: "-",
      message: error.message || "Failed to fetch quota",
    };
  }

  const quotas = parseQuotaData(connection.provider, data)
    .map((quota) => ({
      ...quota,
      remaining: getRemainingPercentage(quota),
    }))
    .filter((quota) => Number.isFinite(quota.remaining));

  if (!quotas.length) {
    return {
      connectionId: connection.id,
      provider: connection.provider,
      label: `${connection.provider} / ${getConnectionLabel(connection)}`,
      status: "unavailable",
      remaining: null,
      quotaName: null,
      resetAt: null,
      resetIn: "-",
      message: data?.message || "No quota data",
    };
  }

  const lowestQuota = [...quotas].sort((a, b) => (
    a.remaining - b.remaining ||
    String(a.name || "").localeCompare(String(b.name || ""))
  ))[0];
  const adjustedQuota = getAdjustedWorkdayQuotaRemaining(
    lowestQuota.remaining,
    lowestQuota.name,
    lowestQuota.resetAt,
    now,
  );

  return {
    connectionId: connection.id,
    provider: connection.provider,
    label: `${connection.provider} / ${getConnectionLabel(connection)}`,
    status: getQuotaStatus(adjustedQuota.remaining),
    remaining: adjustedQuota.remaining,
    rawRemaining: lowestQuota.remaining,
    quotaName: lowestQuota.name || "quota",
    resetAt: lowestQuota.resetAt || null,
    resetIn: formatResetTime(lowestQuota.resetAt),
    isAdjusted: adjustedQuota.isAdjusted,
    message: data?.message || null,
  };
}

async function loadQuotaSnapshot(now = new Date()) {
  const connections = (await getProviderConnections())
    .filter((connection) => (connection.isActive ?? true) && isUsageEligibleConnection(connection));

  const results = await Promise.all(connections.map(async (connection) => {
    try {
      const usage = await withTimeout(
        fetchUsageForConnection(connection),
        QUOTA_FETCH_TIMEOUT_MS,
        "Quota fetch timed out",
      );
      return summarizeQuotaConnection(connection, usage, null, now);
    } catch (error) {
      return summarizeQuotaConnection(connection, null, error, now);
    }
  }));

  const counts = { ok: 0, low: 0, depleted: 0, unavailable: 0 };
  for (const result of results) {
    counts[result.status] += 1;
  }

  const lowest = results
    .filter((result) => Number.isFinite(result.remaining))
    .sort((a, b) => (
      a.remaining - b.remaining ||
      String(a.label).localeCompare(String(b.label))
    ))
    .slice(0, TOP_LOW_QUOTAS_LIMIT);

  return {
    totalTracked: connections.length,
    counts,
    lowest,
  };
}

async function getQuotaSnapshot(now = new Date()) {
  const currentTs = Date.now();
  if (g.quotaSnapshot && currentTs < g.quotaSnapshotExpiresAt) {
    return g.quotaSnapshot;
  }

  if (g.quotaSnapshotPromise) {
    return g.quotaSnapshotPromise;
  }

  g.quotaSnapshotPromise = loadQuotaSnapshot(now)
    .then((snapshot) => {
      g.quotaSnapshot = snapshot;
      g.quotaSnapshotExpiresAt = Date.now() + QUOTA_CACHE_TTL_MS;
      return snapshot;
    })
    .finally(() => {
      g.quotaSnapshotPromise = null;
    });

  return g.quotaSnapshotPromise;
}

function buildQuotaLine(snapshot) {
  if (!snapshot.lowest.length) {
    return "<b>Quota Remaining Today</b>: unavailable";
  }

  if (snapshot.lowest.length === 1) {
    const item = snapshot.lowest[0];
    if (item.isAdjusted) {
      return `<b>Quota Remaining Today</b>: ${item.remaining}%`;
    }
    return `<b>Quota Remaining Today</b>: ${item.remaining}% (${escapeHtml(item.quotaName)}, reset ${escapeHtml(item.resetIn)})`;
  }

  return [
    "<b>Quota Remaining Today</b>:",
    ...snapshot.lowest.map((item) => (
      item.isAdjusted
        ? `- ${escapeHtml(item.label)}: ${item.remaining}%`
        : `- ${escapeHtml(item.label)}: ${item.remaining}% (${escapeHtml(item.quotaName)}, reset ${escapeHtml(item.resetIn)})`
    )),
  ].join("\n");
}

function buildUsageLines(summary) {
  const lines = [`<b>Key usage (${escapeHtml(summary.period)})</b>:`];
  if (summary.sourceCount) {
    lines.push(`T\u1ed5ng h\u1ee3p ${summary.sourceCount} instance.`);
  }
  if (summary.unavailableSources) {
    lines.push(`L\u01b0u \u00fd: ${summary.unavailableSources} ngu\u1ed3n ch\u01b0a \u0111\u1ecdc \u0111\u01b0\u1ee3c, s\u1ed1 li\u1ec7u ch\u01b0a \u0111\u1ea7y \u0111\u1ee7.`);
  }

  if (!summary.items.length) {
    lines.push("No Telegram-key usage.");
    return lines;
  }

  for (const item of summary.items) {
    const name = escapeHtml(item.name || item.telegramUserId || "unknown");
    const models = escapeHtml(item.models?.join(", ") || "unknown");
    lines.push(`${name}: ${formatInteger(item.totalTokens)} tokens - ${models}`);
  }

  return lines;
}

export async function buildTelegramReport(period = "today", now = new Date()) {
  const [quotaSnapshot, usageSummary] = await Promise.all([
    getQuotaSnapshot(now),
    getTelegramReportUsageSummary(period, now),
  ]);

  return [
    buildQuotaLine(quotaSnapshot),
    "",
    ...buildUsageLines(usageSummary),
  ].join("\n");
}

export const __test__ = {
  QUOTA_CACHE_TTL_MS,
  QUOTA_FETCH_TIMEOUT_MS,
  TOP_LOW_QUOTAS_LIMIT,
  buildQuotaLine,
  buildUsageLines,
  escapeHtml,
  formatSharePercentage,
  formatUsd,
  getQuotaStatus,
  getQuotaSnapshot,
  getAdjustedWorkdayQuotaRemaining,
  countFutureVietnamBusinessDays,
  isWeeklyQuota,
  resetQuotaCache() {
    g.quotaSnapshot = null;
    g.quotaSnapshotExpiresAt = 0;
    g.quotaSnapshotPromise = null;
  },
  summarizeQuotaConnection,
};

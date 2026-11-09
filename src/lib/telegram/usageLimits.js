import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { getApiKeyByKey, updateApiKey } from "@/lib/db/repos/apiKeysRepo.js";
import {
  API_KEY_SOURCES,
  VIETNAM_TIMEZONE,
  formatVietnamDateTime,
  getNextVietnamBusinessStartAfter,
  getVietnamDateKey,
  getVietnamStartOfDay,
} from "@/lib/apiKeys/schedule.js";
import { TELEGRAM_API_BASE_URL, isTelegramDisabled } from "./config.js";

const WARNING_COST_USD = 400;
const WARNING_TOKENS = 180_000_000;
const HARD_COST_USD = 1000;
const HARD_TOKENS = 600_000_000;
const KV_SCOPE = "telegramUsageLimits";
const MANUAL_CLEAR_EXTRA_COST_USD = HARD_COST_USD;
const MANUAL_CLEAR_EXTRA_TOKENS = HARD_TOKENS;

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatTokens(value) {
  return `${Number(value || 0).toLocaleString("en-US")} token`;
}

export async function sendTelegramMessage(chatId, text) {
  if (isTelegramDisabled()) return;
  const response = await fetch(`${TELEGRAM_API_BASE_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`sendMessage HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok) throw new Error(payload?.description || "sendMessage failed");
}

function claimOnce(db, key, value) {
  const result = db.run(
    `INSERT OR IGNORE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
    [KV_SCOPE, key, stringifyJson(value)]
  );
  return (result?.changes ?? 0) > 0;
}

function getLimitOverrideKey(dateKey, apiKeyId) {
  return `${dateKey}|${apiKeyId}|manual-clear-limit`;
}

function getDailyLimitOverride(db, dateKey, apiKeyId) {
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
    KV_SCOPE,
    getLimitOverrideKey(dateKey, apiKeyId),
  ]);
  return row ? parseJson(row.value, null) : null;
}

function getEffectiveHardLimits(override) {
  const overrideCost = Number(override?.hardCostUsd || 0);
  const overrideTokens = Number(override?.hardTokens || 0);
  return {
    hardCostUsd: Math.max(HARD_COST_USD, Number.isFinite(overrideCost) ? overrideCost : 0),
    hardTokens: Math.max(HARD_TOKENS, Number.isFinite(overrideTokens) ? overrideTokens : 0),
  };
}

function isHardLimitReached(totals, hardLimits) {
  return (
    Number(totals?.totalCost || 0) >= Number(hardLimits?.hardCostUsd || HARD_COST_USD) ||
    Number(totals?.totalTokens || 0) >= Number(hardLimits?.hardTokens || HARD_TOKENS)
  );
}

function setDailyLimitOverride(db, apiKey, now) {
  const dateKey = getVietnamDateKey(now);
  const totals = getDailyTotals(db, apiKey.key, now);
  const override = {
    at: now.toISOString(),
    baseCostUsd: totals.totalCost,
    baseTokens: totals.totalTokens,
    hardCostUsd: Math.max(HARD_COST_USD, totals.totalCost + MANUAL_CLEAR_EXTRA_COST_USD),
    hardTokens: Math.max(HARD_TOKENS, totals.totalTokens + MANUAL_CLEAR_EXTRA_TOKENS),
  };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [KV_SCOPE, getLimitOverrideKey(dateKey, apiKey.id), stringifyJson(override)]
  );
  return override;
}

function buildWarningMessage(apiKey, totals) {
  return [
    "Cảnh báo sử dụng nhanh.",
    `API key: ${apiKey.name || apiKey.telegramUserId || "unknown"}`,
    `Hôm nay bạn đã dùng ${formatTokens(totals.totalTokens)} (${formatUsd(totals.totalCost)}).`,
    "Bạn đang burn quá nhanh, hãy kiểm soát lượng token sử dụng.",
    `Soft limit tạm ngắt: ${formatUsd(HARD_COST_USD)} hoặc ${formatTokens(HARD_TOKENS)} trong ngày.`,
  ].join("\n");
}

function buildHardLimitMessage(apiKey, totals, disabledUntil) {
  return [
    "API key của bạn đã tạm bị vô hiệu hóa.",
    `API key: ${apiKey.name || apiKey.telegramUserId || "unknown"}`,
    `Lý do: hôm nay đã đạt ${formatTokens(totals.totalTokens)} (${formatUsd(totals.totalCost)}).`,
    "Hệ thống đã tạm chuyển key sang inactive để bảo vệ quota.",
    `Key sẽ tự mở lại lúc 08:00 ngày làm việc tiếp theo (${VIETNAM_TIMEZONE}).`,
    `Mốc mở lại: ${formatVietnamDateTime(disabledUntil)}`,
  ].join("\n");
}

function buildManualWarningMessage(apiKey) {
  return [
    "Cảnh báo sử dụng nhanh.",
    `API key: ${apiKey.name || apiKey.telegramUserId || "unknown"}`,
    "Bạn đang burn token quá nhanh, hãy kiểm soát lượng sử dụng trong hôm nay.",
    `Soft limit tạm ngắt: ${formatUsd(HARD_COST_USD)} hoặc ${formatTokens(HARD_TOKENS)} trong ngày.`,
  ].join("\n");
}

function buildManualTemporaryDisableMessage(apiKey, disabledUntil) {
  return [
    "API key của bạn đã tạm bị vô hiệu hóa.",
    `API key: ${apiKey.name || apiKey.telegramUserId || "unknown"}`,
    "Bot đã tự động tạm chuyển key sang inactive để bảo vệ quota hệ thống.",
    `Key sẽ tự mở lại lúc 08:00 ngày làm việc tiếp theo (${VIETNAM_TIMEZONE}).`,
    `Mốc mở lại: ${formatVietnamDateTime(disabledUntil)}`,
  ].join("\n");
}

function buildManualTemporaryEnableMessage(apiKey, updated, override) {
  const lines = [
    "API key của bạn đã được gỡ trạng thái tạm vô hiệu hóa.",
    `API key: ${apiKey.name || apiKey.telegramUserId || "unknown"}`,
    `Hạn mức tạm thời trong hôm nay đã được nâng lên ${formatUsd(override?.hardCostUsd)} hoặc ${formatTokens(override?.hardTokens)}.`,
  ];
  if (updated?.isActive) {
    lines.push("Key hiện đã active trở lại.");
  } else {
    lines.push(`Key sẽ hoạt động lại trong khung giờ cho phép: thứ 2-6, 08:00-18:30 (${VIETNAM_TIMEZONE}).`);
  }
  return lines.join("\n");
}

function assertTelegramApiKey(apiKey) {
  if (
    !apiKey ||
    apiKey.source !== API_KEY_SOURCES.TELEGRAM ||
    !apiKey.telegramUserId
  ) {
    throw new Error("Telegram API key is required");
  }
}

export async function sendManualTelegramUsageWarning(apiKey) {
  assertTelegramApiKey(apiKey);
  await sendTelegramMessage(
    apiKey.telegramUserId,
    buildManualWarningMessage(apiKey)
  );
  return { action: "warning", apiKeyId: apiKey.id };
}

export async function temporaryDisableTelegramApiKey(apiKey, now = new Date()) {
  assertTelegramApiKey(apiKey);
  const disabledUntil = getNextVietnamBusinessStartAfter(now);
  const updated = await updateApiKey(apiKey.id, {
    temporaryDisabledUntil: disabledUntil.toISOString(),
    now,
  });
  await sendTelegramMessage(
    apiKey.telegramUserId,
    buildManualTemporaryDisableMessage(apiKey, disabledUntil)
  );
  return {
    action: "temporary-disable",
    apiKeyId: apiKey.id,
    disabledUntil: disabledUntil.toISOString(),
    key: updated,
  };
}

export async function clearTemporaryDisableTelegramApiKey(apiKey, now = new Date()) {
  assertTelegramApiKey(apiKey);
  const db = await getAdapter();
  const override = setDailyLimitOverride(db, apiKey, now);
  const updated = await updateApiKey(apiKey.id, {
    temporaryDisabledUntil: null,
    now,
  });
  await sendTelegramMessage(
    apiKey.telegramUserId,
    buildManualTemporaryEnableMessage(apiKey, updated, override)
  );
  return {
    action: "clear-temporary-disable",
    apiKeyId: apiKey.id,
    limitOverride: override,
    key: updated,
  };
}

function getDailyTotals(db, apiKey, now) {
  const start = getVietnamStartOfDay(now, 0);
  const row = db.get(
    `SELECT
       COALESCE(SUM(promptTokens + completionTokens), 0) AS totalTokens,
       COALESCE(SUM(cost), 0) AS totalCost
     FROM usageHistory
     WHERE apiKey = ? AND timestamp >= ? AND timestamp <= ?`,
    [apiKey, start.toISOString(), now.toISOString()]
  ) || {};
  return {
    totalTokens: Number(row.totalTokens || 0),
    totalCost: Number(row.totalCost || 0),
  };
}

export async function enforceTelegramDailyUsageLimits(entry) {
  if (isTelegramDisabled()) return null;
  const rawApiKey = typeof entry?.apiKey === "string" ? entry.apiKey : "";
  if (!rawApiKey) return null;

  const apiKey = await getApiKeyByKey(rawApiKey);
  if (
    !apiKey ||
    apiKey.source !== API_KEY_SOURCES.TELEGRAM ||
    !apiKey.telegramUserId
  ) {
    return null;
  }

  const now = entry?.timestamp ? new Date(entry.timestamp) : new Date();
  const db = await getAdapter();
  const totals = getDailyTotals(db, rawApiKey, now);
  const dateKey = getVietnamDateKey(now);
  const hardLimits = getEffectiveHardLimits(getDailyLimitOverride(db, dateKey, apiKey.id));

  const hardLimitReached = isHardLimitReached(totals, hardLimits);
  const warningReached =
    totals.totalCost >= WARNING_COST_USD ||
    totals.totalTokens >= WARNING_TOKENS;

  if (hardLimitReached) {
    const disabledUntil = getNextVietnamBusinessStartAfter(now);
    await updateApiKey(apiKey.id, {
      temporaryDisabledUntil: disabledUntil.toISOString(),
      now,
    });

    const markerKey = `${dateKey}|${apiKey.id}|hard`;
    if (claimOnce(db, markerKey, { at: now.toISOString(), totals })) {
      await sendTelegramMessage(
        apiKey.telegramUserId,
        buildHardLimitMessage(apiKey, totals, disabledUntil)
      );
    }
    return { action: "hard", apiKeyId: apiKey.id, totals };
  }

  if (warningReached) {
    const markerKey = `${dateKey}|${apiKey.id}|warning`;
    if (claimOnce(db, markerKey, { at: now.toISOString(), totals })) {
      await sendTelegramMessage(
        apiKey.telegramUserId,
        buildWarningMessage(apiKey, totals)
      );
    }
    return { action: "warning", apiKeyId: apiKey.id, totals };
  }

  return { action: "none", apiKeyId: apiKey.id, totals };
}

export const __test__ = {
  WARNING_COST_USD,
  WARNING_TOKENS,
  HARD_COST_USD,
  HARD_TOKENS,
  MANUAL_CLEAR_EXTRA_COST_USD,
  MANUAL_CLEAR_EXTRA_TOKENS,
  buildWarningMessage,
  buildHardLimitMessage,
  buildManualWarningMessage,
  buildManualTemporaryDisableMessage,
  buildManualTemporaryEnableMessage,
  getEffectiveHardLimits,
  getLimitOverrideKey,
  isHardLimitReached,
};

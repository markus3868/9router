import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { DATA_FILE } from "@/lib/db/paths.js";
import { openReadOnlyDatabase } from "@/lib/db/driver.js";
import { getTelegramUsageShareSummary } from "@/lib/localDb";
import { getProviderAlias } from "@/shared/constants/providers.js";
import {
  VIETNAM_TIMEZONE,
  formatVietnamDateTime,
  getVietnamStartOfDay,
} from "@/lib/apiKeys/schedule.js";

// ponytail: same-host SQLite only; use an authenticated collector for remote hosts.
export async function getTelegramReportUsageSummary(period = "today", now = new Date()) {
  const peers = (process.env.TELEGRAM_REPORT_DATA_DIRS || "")
    .split(",").map((dir) => dir.trim()).filter(Boolean);
  if (!peers.length) return getTelegramUsageShareSummary(period, now);

  const start = getVietnamStartOfDay(now, period === "7d" ? 6 : 0);
  const startIso = start.toISOString();
  const endIso = now.toISOString();
  const files = [...new Set([DATA_FILE, ...peers.map((dir) => path.resolve(dir, "db/data.sqlite"))])];
  const visited = new Set();
  const seenRequests = new Set();
  const users = new Map();
  const usage = new Map();
  let sourceCount = 0;
  let unavailableSources = 0;
  let duplicatesRemoved = 0;

  for (const file of files) {
    let db;
    let keys;
    let rows;
    try {
      const canonical = realpathSync(file);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      db = await openReadOnlyDatabase(canonical);
      db.exec("PRAGMA busy_timeout = 1000; BEGIN");
      keys = db.prepare(
        "SELECT key, name, telegramUserId, updatedAt FROM apiKeys WHERE source = 'telegram'"
      ).all();
      rows = db.prepare(
        `SELECT u.id, u.timestamp, u.apiKey, u.provider, u.model, u.connectionId,
                u.promptTokens, u.completionTokens, u.tokens, u.cost
         FROM usageHistory u JOIN apiKeys k ON k.key = u.apiKey
         WHERE k.source = 'telegram' AND u.timestamp >= ? AND u.timestamp <= ?`
      ).all(startIso, endIso);
    } catch {
      unavailableSources += 1;
      continue;
    } finally {
      db?.close();
    }

    sourceCount += 1;
    const keyUsers = new Map();
    for (const key of keys) {
      const identity = key.telegramUserId ? `telegram:${key.telegramUserId}` : `key:${key.key}`;
      keyUsers.set(key.key, identity);
      const previous = users.get(identity);
      if (!previous || (key.updatedAt || "") > (previous.updatedAt || "")) {
        users.set(identity, key);
      }
    }

    const sourceRequests = new Set();
    for (const row of rows) {
      let promptTokens = row.promptTokens;
      let completionTokens = row.completionTokens;
      if (typeof promptTokens !== "number" && typeof completionTokens !== "number") {
        let tokens = {};
        try { tokens = JSON.parse(row.tokens || "{}") || {}; } catch {}
        promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
        completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;
      }
      promptTokens ||= 0;
      completionTokens ||= 0;
      const totalTokens = promptTokens + completionTokens;
      if (totalTokens <= 0) continue;

      // Include the original row ID: cloned history matches, new independent rows do not.
      const fingerprint = createHash("sha256").update(JSON.stringify([
        row.id, row.timestamp, row.apiKey, row.provider, row.model,
        row.connectionId, promptTokens, completionTokens,
      ])).digest("hex");
      if (seenRequests.has(fingerprint)) {
        duplicatesRemoved += 1;
        continue;
      }
      sourceRequests.add(fingerprint);

      const identity = keyUsers.get(row.apiKey);
      const item = usage.get(identity) || {
        cost: 0, promptTokens: 0, completionTokens: 0,
        totalTokens: 0, requests: 0, lastUsed: row.timestamp,
        models: new Set(),
      };
      if (row.model) {
        const alias = getProviderAlias(row.provider);
        item.models.add(alias && !row.model.startsWith(`${alias}/`) ? `${alias}/${row.model}` : row.model);
      }
      item.cost += row.cost || 0;
      item.promptTokens += promptTokens;
      item.completionTokens += completionTokens;
      item.totalTokens += totalTokens;
      item.requests += 1;
      if (row.timestamp > item.lastUsed) item.lastUsed = row.timestamp;
      usage.set(identity, item);
    }
    for (const fingerprint of sourceRequests) seenRequests.add(fingerprint);
  }

  if (!sourceCount) throw new Error("Telegram report usage sources unavailable");
  const items = [...usage].map(([identity, item]) => ({
    ...item,
    models: [...item.models].sort(),
    name: users.get(identity)?.name || null,
    telegramUserId: users.get(identity)?.telegramUserId || null,
  }));
  const totalTokens = items.reduce((total, item) => total + item.totalTokens, 0);
  items.sort((a, b) => b.totalTokens - a.totalTokens ||
    b.lastUsed.localeCompare(a.lastUsed) ||
    String(a.name || "").localeCompare(String(b.name || "")));

  return {
    period: period === "7d" ? "7D" : "Today",
    timezone: VIETNAM_TIMEZONE,
    windowStart: startIso,
    windowEnd: endIso,
    windowStartLabel: formatVietnamDateTime(start),
    windowEndLabel: formatVietnamDateTime(now),
    totalTelegramKeys: users.size,
    keysWithUsage: items.length,
    totalRequests: items.reduce((total, item) => total + item.requests, 0),
    totalCost: items.reduce((total, item) => total + item.cost, 0),
    totalTokens,
    items: items.map((item) => ({ ...item, share: item.totalTokens / totalTokens })),
    sourceCount,
    unavailableSources,
    duplicatesRemoved,
  };
}

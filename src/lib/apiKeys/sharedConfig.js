import { realpathSync } from "node:fs";
import path from "node:path";
import { DATA_FILE } from "@/lib/db/paths.js";
import { computeApiKeyIsActive } from "./schedule.js";

function getSourceFile() {
  const dir = process.env.TELEGRAM_CONFIG_SOURCE_DATA_DIR?.trim();
  if (!dir) return null;
  const file = realpathSync(path.resolve(dir, "db/data.sqlite"));
  return file === realpathSync(DATA_FILE) ? null : file;
}

export function assertTelegramConfigWritable() {
  if (!getSourceFile()) return;
  const error = new Error("Telegram model and working hours are managed on the primary instance (20128).");
  error.status = 409;
  throw error;
}

// ponytail: same-host Node SQLite only; remote hosts need an authenticated config service.
async function readConfig() {
  const file = getSourceFile();
  if (!file) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 250; BEGIN");
    const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
    const settings = row ? JSON.parse(row.data) : {};
    const keys = db.prepare(
      "SELECT telegramUserId, forcedModel FROM apiKeys WHERE source = 'telegram' AND telegramUserId IS NOT NULL"
    ).all();
    return {
      workingHoursEnabled: settings.telegramWorkingHoursEnabled !== false,
      models: new Map(keys.map((key) => [String(key.telegramUserId), key.forcedModel || null])),
    };
  } finally {
    db.close();
  }
}

export async function getSharedTelegramSettings() {
  const config = await readConfig();
  return config ? { telegramWorkingHoursEnabled: config.workingHoursEnabled } : {};
}

export async function applySharedTelegramConfig(keys, now = new Date()) {
  if (!keys.some((key) => key?.source === "telegram")) return keys;
  const config = await readConfig();
  if (!config) return keys;
  return keys.map((key) => {
    if (key?.source !== "telegram") return key;
    const userId = String(key.telegramUserId);
    const configured = config.models.has(userId)
      ? { ...key, forcedModel: config.models.get(userId) }
      : { ...key };
    configured.isActive = computeApiKeyIsActive(configured, now, {
      workingHoursEnabled: config.workingHoursEnabled,
    });
    return configured;
  });
}

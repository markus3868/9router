import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  API_KEY_SCHEDULE_MODES,
  API_KEY_SOURCES,
  computeApiKeyIsActive,
} from "@/lib/apiKeys/schedule.js";
import { generateApiKeyWithMachine } from "@/shared/utils/apiKey.js";
import { getSettings } from "./settingsRepo.js";

function boolFromDb(value) {
  return value === 1 || value === true;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: boolFromDb(row.isActive),
    source: row.source || API_KEY_SOURCES.MANUAL,
    telegramUserId: row.telegramUserId || null,
    scheduleMode: row.scheduleMode || API_KEY_SCHEDULE_MODES.NONE,
    updatedAt: row.updatedAt || row.createdAt,
    manualDisabled: boolFromDb(row.manualDisabled),
    forcedModel: row.forcedModel || null,
    temporaryDisabledUntil: row.temporaryDisabledUntil || null,
    createdAt: row.createdAt,
  };
}

function normalizeKeyRecord(data, now = new Date(), options = {}) {
  const nowIso = now.toISOString();
  const normalized = {
    id: data.id,
    key: data.key,
    name: data.name || null,
    machineId: data.machineId || null,
    source: data.source || API_KEY_SOURCES.MANUAL,
    telegramUserId: data.telegramUserId ? String(data.telegramUserId) : null,
    scheduleMode: data.scheduleMode || API_KEY_SCHEDULE_MODES.NONE,
    manualDisabled: data.manualDisabled === true,
    forcedModel: typeof data.forcedModel === "string" && data.forcedModel.trim()
      ? data.forcedModel.trim()
      : null,
    temporaryDisabledUntil: typeof data.temporaryDisabledUntil === "string" && data.temporaryDisabledUntil.trim()
      ? data.temporaryDisabledUntil.trim()
      : null,
    createdAt: data.createdAt || nowIso,
    updatedAt: nowIso,
  };
  normalized.isActive = computeApiKeyIsActive(normalized, now, options);
  return normalized;
}

function persistKey(db, key) {
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, source, telegramUserId, scheduleMode, updatedAt, manualDisabled, forcedModel, temporaryDisabledUntil, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       key = excluded.key,
       name = excluded.name,
       machineId = excluded.machineId,
       isActive = excluded.isActive,
       source = excluded.source,
       telegramUserId = excluded.telegramUserId,
       scheduleMode = excluded.scheduleMode,
       updatedAt = excluded.updatedAt,
       manualDisabled = excluded.manualDisabled,
       forcedModel = excluded.forcedModel,
       temporaryDisabledUntil = excluded.temporaryDisabledUntil,
       createdAt = excluded.createdAt`,
    [
      key.id,
      key.key,
      key.name,
      key.machineId,
      key.isActive ? 1 : 0,
      key.source,
      key.telegramUserId,
      key.scheduleMode,
      key.updatedAt,
      key.manualDisabled ? 1 : 0,
      key.forcedModel,
      key.temporaryDisabledUntil,
      key.createdAt,
    ]
  );
}

function normalizePatch(existing, data = {}) {
  const patch = { ...data };
  if (Object.prototype.hasOwnProperty.call(patch, "isActive")) {
    patch.manualDisabled = patch.isActive === false;
    delete patch.isActive;
  }
  return { ...existing, ...patch };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function getApiKeyByTelegramUserId(telegramUserId) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE telegramUserId = ?`, [String(telegramUserId)]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const result = generateApiKeyWithMachine(machineId);
  const now = options.now instanceof Date ? options.now : new Date();
  const apiKey = normalizeKeyRecord({
    id: uuidv4(),
    key: result.key,
    name,
    machineId,
    source: options.source || API_KEY_SOURCES.MANUAL,
    telegramUserId: options.telegramUserId || null,
    scheduleMode: options.scheduleMode || API_KEY_SCHEDULE_MODES.NONE,
    manualDisabled: options.manualDisabled === true,
    createdAt: now.toISOString(),
  }, now);
  persistKey(db, apiKey);
  return apiKey;
}

export async function upsertTelegramApiKey({ telegramUserId, username, machineId, now = new Date() }) {
  if (!telegramUserId) throw new Error("telegramUserId is required");
  if (!username) throw new Error("username is required");
  if (!machineId) throw new Error("machineId is required");

  const db = await getAdapter();
  const settings = await getSettings();
  const scheduleOptions = {
    workingHoursEnabled: settings.telegramWorkingHoursEnabled !== false,
  };
  let result = null;

  db.transaction(() => {
    const existingRow = db.get(`SELECT * FROM apiKeys WHERE telegramUserId = ?`, [String(telegramUserId)]);
    if (existingRow) {
      const merged = normalizePatch(rowToKey(existingRow), {
        name: username,
        source: API_KEY_SOURCES.TELEGRAM,
        telegramUserId: String(telegramUserId),
        scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
      });
      result = normalizeKeyRecord(merged, now, scheduleOptions);
      persistKey(db, result);
      return;
    }

    const generated = generateApiKeyWithMachine(machineId);
    result = normalizeKeyRecord({
      id: uuidv4(),
      key: generated.key,
      name: username,
      machineId,
      source: API_KEY_SOURCES.TELEGRAM,
      telegramUserId: String(telegramUserId),
      scheduleMode: API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS,
      manualDisabled: false,
      createdAt: now.toISOString(),
    }, now, scheduleOptions);
    persistKey(db, result);
  });

  return result;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  const now = data?.now instanceof Date ? data.now : new Date();
  const settings = await getSettings();
  const scheduleOptions = {
    workingHoursEnabled: settings.telegramWorkingHoursEnabled !== false,
  };

  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = normalizePatch(rowToKey(row), data);
    result = normalizeKeyRecord(merged, now, scheduleOptions);
    persistKey(db, result);
  });

  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function reconcileTelegramApiKeySchedule(now = new Date()) {
  const db = await getAdapter();
  const settings = await getSettings();
  const scheduleOptions = {
    workingHoursEnabled: settings.telegramWorkingHoursEnabled !== false,
  };
  const rows = db.all(
    `SELECT * FROM apiKeys WHERE scheduleMode = ?`,
    [API_KEY_SCHEDULE_MODES.VN_BUSINESS_HOURS]
  );

  const changes = rows.flatMap((row) => {
    const key = rowToKey(row);
    const desired = computeApiKeyIsActive(key, now, scheduleOptions);
    if (desired === key.isActive) return [];
    return [{ ...key, isActive: desired, updatedAt: now.toISOString() }];
  });

  db.transaction(() => {
    for (const key of changes) {
      db.run(`UPDATE apiKeys SET isActive = ?, updatedAt = ? WHERE id = ?`, [
        key.isActive ? 1 : 0,
        key.updatedAt,
        key.id,
      ]);
    }
  });

  return { total: rows.length, updated: changes.length };
}

export async function validateApiKey(key) {
  const validated = await resolveValidatedApiKey(key);
  return !!validated;
}

export async function resolveValidatedApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return null;

  const normalized = rowToKey(row);
  const now = new Date();
  const settings = await getSettings();
  const desired = computeApiKeyIsActive(normalized, now, {
    workingHoursEnabled: settings.telegramWorkingHoursEnabled !== false,
  });
  if (desired !== normalized.isActive) {
    db.run(`UPDATE apiKeys SET isActive = ?, updatedAt = ? WHERE id = ?`, [
      desired ? 1 : 0,
      now.toISOString(),
      normalized.id,
    ]);
  }
  if (!desired) return null;
  return {
    ...normalized,
    isActive: desired,
    updatedAt: desired !== normalized.isActive ? now.toISOString() : normalized.updatedAt,
  };
}

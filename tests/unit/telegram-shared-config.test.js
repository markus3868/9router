import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root, source, peerDir, sourceDir, db, telegram, manual;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-shared-config-"));
  sourceDir = path.join(root, "primary");
  peerDir = path.join(root, "peer");
  fs.mkdirSync(path.join(sourceDir, "db"), { recursive: true });
  source = new DatabaseSync(path.join(sourceDir, "db/data.sqlite"));
  source.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT);
    CREATE TABLE apiKeys (telegramUserId TEXT, source TEXT, forcedModel TEXT);
    INSERT INTO settings VALUES (1, '{"telegramWorkingHoursEnabled":false,"cloudEnabled":true}');
    INSERT INTO apiKeys VALUES ('42','telegram','cx/gpt-6-luna');
    INSERT INTO apiKeys VALUES ('99','manual','cx/not-a-telegram-model');
  `);
  vi.stubEnv("DATA_DIR", peerDir);
  vi.stubEnv("TELEGRAM_CONFIG_SOURCE_DATA_DIR", "");
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  telegram = await db.upsertTelegramApiKey({
    telegramUserId: "42", username: "alice", machineId: "peer-machine",
  });
  await db.updateApiKey(telegram.id, { forcedModel: "cx/stale-model" });
  manual = await db.createApiKey("manual", "peer-machine");
  await db.updateApiKey(manual.id, { forcedModel: "cx/manual-model" });
  vi.stubEnv("TELEGRAM_CONFIG_SOURCE_DATA_DIR", sourceDir);
});

afterEach(() => {
  vi.useRealTimers();
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  source?.close();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("shared Telegram model and working-hour configuration", () => {
  it("uses primary models in every read/auth path and sees changes without restarting", async () => {
    for (const read of [
      () => db.getApiKeyById(telegram.id),
      () => db.getApiKeyByKey(telegram.key),
      () => db.getApiKeyByTelegramUserId("42"),
      async () => (await db.getApiKeys()).find((key) => key.id === telegram.id),
      () => db.resolveValidatedApiKey(telegram.key),
    ]) {
      expect((await read()).forcedModel).toBe("cx/gpt-6-luna");
    }
    source.prepare("UPDATE apiKeys SET forcedModel=? WHERE telegramUserId=?").run("cx/gpt-6-sol", "42");
    expect((await db.resolveValidatedApiKey(telegram.key)).forcedModel).toBe("cx/gpt-6-sol");
    source.prepare("UPDATE apiKeys SET forcedModel=NULL WHERE telegramUserId='42'").run();
    expect((await db.resolveValidatedApiKey(telegram.key)).forcedModel).toBeNull();
  });

  it("applies working hours immediately, including weekends, without bypassing manual/temp disables", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T03:00:00.000Z"));
    expect(await db.validateApiKey(telegram.key)).toBe(true);
    source.prepare("UPDATE settings SET data=?").run('{"telegramWorkingHoursEnabled":true}');
    expect(await db.validateApiKey(telegram.key)).toBe(false);
    expect((await db.getApiKeyById(telegram.id)).isActive).toBe(false);
    source.prepare("UPDATE settings SET data=?").run('{"telegramWorkingHoursEnabled":false}');
    expect((await db.getApiKeyById(telegram.id)).isActive).toBe(true);
    expect(await db.validateApiKey(telegram.key)).toBe(true);
    const paused = await db.updateApiKey(telegram.id, { isActive: false });
    expect(paused.forcedModel).toBe("cx/gpt-6-luna");
    expect(await db.validateApiKey(telegram.key)).toBe(false);
    await db.updateApiKey(telegram.id, {
      isActive: true, temporaryDisabledUntil: "2026-11-09T01:00:00.000Z",
    });
    expect(await db.validateApiKey(telegram.key)).toBe(false);
    expect(await db.validateApiKey(manual.key)).toBe(true);
  });

  it("preserves independent settings, manual keys and stored peer model configuration", async () => {
    expect(await db.getSettings()).toMatchObject({
      telegramWorkingHoursEnabled: false, cloudEnabled: false,
    });
    expect((await db.updateSettings({ cloudEnabled: true })).cloudEnabled).toBe(true);
    expect((await db.getApiKeyById(manual.id)).forcedModel).toBe("cx/manual-model");
    expect((await db.updateApiKey(manual.id, { forcedModel: "ds/manual" })).forcedModel).toBe("ds/manual");
    const exported = await db.exportDb();
    expect(exported.apiKeys.find((key) => key.id === telegram.id).forcedModel).toBe("cx/stale-model");
    expect(source.prepare("SELECT forcedModel FROM apiKeys WHERE telegramUserId='42'").get().forcedModel)
      .toBe("cx/gpt-6-luna");
  });

  it("rejects conflicting edits on peers without changing their stored values", async () => {
    await expect(db.updateApiKey(telegram.id, { forcedModel: "cx/conflict" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(db.updateSettings({ telegramWorkingHoursEnabled: true }))
      .rejects.toMatchObject({ status: 409 });
    expect((await db.getApiKeyById(telegram.id)).forcedModel).toBe("cx/gpt-6-luna");
  });

  it("leaves standalone instances and keys absent from the primary unchanged", async () => {
    source.prepare("DELETE FROM apiKeys WHERE telegramUserId='42'").run();
    expect((await db.getApiKeyById(telegram.id)).forcedModel).toBe("cx/stale-model");
    vi.stubEnv("TELEGRAM_CONFIG_SOURCE_DATA_DIR", "");
    expect((await db.updateApiKey(telegram.id, { forcedModel: "cx/standalone" })).forcedModel)
      .toBe("cx/standalone");
    expect((await db.updateSettings({ telegramWorkingHoursEnabled: false })).telegramWorkingHoursEnabled)
      .toBe(false);
  });

  it("allows the primary to point at itself, including through a symlink", async () => {
    const alias = path.join(root, "peer-alias");
    fs.symlinkSync(peerDir, alias);
    vi.stubEnv("TELEGRAM_CONFIG_SOURCE_DATA_DIR", alias);
    expect((await db.updateApiKey(telegram.id, { forcedModel: "cx/primary" })).forcedModel)
      .toBe("cx/primary");
    expect((await db.updateSettings({ telegramWorkingHoursEnabled: false })).telegramWorkingHoursEnabled)
      .toBe(false);
  });

  it("fails closed for an unreadable source instead of using stale model or schedule settings", async () => {
    const missing = path.join(root, "missing");
    vi.stubEnv("TELEGRAM_CONFIG_SOURCE_DATA_DIR", missing);
    await expect(db.resolveValidatedApiKey(telegram.key)).rejects.toThrow();
    await expect(db.getSettings()).rejects.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });
});

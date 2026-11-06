import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  dataFile: "",
  getTelegramUsageShareSummary: vi.fn(),
}));
vi.mock("@/lib/db/paths.js", () => ({ get DATA_FILE() { return mocks.dataFile; } }));
vi.mock("@/lib/localDb", () => ({
  getTelegramUsageShareSummary: mocks.getTelegramUsageShareSummary,
}));

let root;
const now = new Date("2026-11-05T06:00:00.000Z");
const today = "2026-11-04T17:00:00.000Z";
const key = (raw = "secret-a", user = "123", name = "alice", source = "telegram") => ({
  key: raw, telegramUserId: user, name, source, updatedAt: "2026-11-01T00:00:00.000Z",
});
const request = (overrides = {}) => ({
  id: 1, timestamp: today, apiKey: "secret-a", provider: "codex", model: "gpt-5.4",
  connectionId: "connection", promptTokens: 90, completionTokens: 10, cost: 1,
  tokens: null, ...overrides,
});

function database(name, keys = [key()], rows = [request()]) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db/data.sqlite"));
  db.exec(`
    CREATE TABLE apiKeys (key TEXT PRIMARY KEY, telegramUserId TEXT, name TEXT, source TEXT, updatedAt TEXT);
    CREATE TABLE usageHistory (id INTEGER, timestamp TEXT, apiKey TEXT, provider TEXT, model TEXT,
      connectionId TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL, tokens TEXT);
    CREATE INDEX idx_ts ON usageHistory(timestamp);
  `);
  for (const k of keys) db.prepare("INSERT INTO apiKeys VALUES (?, ?, ?, ?, ?)").run(
    k.key, k.telegramUserId, k.name, k.source, k.updatedAt,
  );
  for (const r of rows) db.prepare("INSERT INTO usageHistory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    r.id, r.timestamp, r.apiKey, r.provider, r.model, r.connectionId,
    r.promptTokens, r.completionTokens, r.cost, r.tokens,
  );
  db.close();
  return dir;
}

async function summarize(period = "today") {
  const { getTelegramReportUsageSummary } = await import("../../src/lib/telegram/reportUsage.js");
  return getTelegramReportUsageSummary(period, now);
}

describe("multi-instance Telegram reports", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    root = mkdtempSync(path.join(os.tmpdir(), "9router-report-"));
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", "");
    mocks.dataFile = path.join(database("main"), "db/data.sqlite");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps single-instance behavior without configuration", async () => {
    mocks.getTelegramUsageShareSummary.mockResolvedValue({ totalTokens: 123 });
    expect(await summarize()).toEqual({ totalTokens: 123 });
    expect(mocks.getTelegramUsageShareSummary).toHaveBeenCalledWith("today", now);
  });

  it("deduplicates clones, merges Telegram identities, recalculates shares and cost", async () => {
    const peer = database("peer", [
      { ...key("secret-new", "123", "alice-new"), updatedAt: "2026-11-05T00:00:00.000Z" },
      key(), key("secret-b", "456", "bob"), key("manual", null, "manual", "manual"),
    ], [
      request(),
      request({ id: 2, apiKey: "secret-new", cost: 2 }),
      request({ id: 3, apiKey: "secret-b", promptTokens: 300, completionTokens: 0, cost: 3 }),
      request({ id: 4, apiKey: "manual", promptTokens: 9999 }),
      request({ id: 5, apiKey: "local-no-key", promptTokens: 9999 }),
    ]);
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", peer);
    const summary = await summarize();
    expect(summary).toMatchObject({
      sourceCount: 2, unavailableSources: 0, duplicatesRemoved: 1,
      totalTelegramKeys: 2, keysWithUsage: 2, totalTokens: 500, totalCost: 6, totalRequests: 3,
    });
    expect(summary.items).toMatchObject([
      { name: "bob", share: 0.6, totalTokens: 300 },
      { name: "alice-new", share: 0.4, totalTokens: 200, cost: 3 },
    ]);
    expect(JSON.stringify(summary)).not.toContain("secret-");
  });

  it("includes distinct models across instances, grouped by Telegram user", async () => {
    const peer = database("peer", [key()], [
      request(),
      request({ id: 2, model: "gpt-5.4-mini" }),
      request({ id: 3, provider: "deepseek", model: "deepseek-v4-flash" }),
      request({ id: 4, provider: null, model: "custom-model" }),
      request({ id: 5, model: null }),
      request({ id: 6, model: "unused", promptTokens: 0, completionTokens: 0 }),
      request({ id: 7, model: "yesterday-model", timestamp: "2026-11-04T16:59:59.999Z" }),
      request({ id: 8, model: "cx/gpt-5.4" }),
    ]);
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", peer);
    const summary = await summarize();
    expect(summary.items[0].models).toEqual([
      "custom-model", "cx/gpt-5.4", "cx/gpt-5.4-mini", "ds/deepseek-v4-flash",
    ]);
    expect((await summarize("7d")).items[0].models).toContain("cx/yesterday-model");
    expect(summary.totalRequests).toBe(6);
  });

  it("does not discard independent rows with colliding clone row IDs", async () => {
    const peer = database("peer", [key()], [
      request({ timestamp: "2026-11-04T17:00:00.001Z" }),
    ]);
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", peer);
    expect(await summarize()).toMatchObject({ totalTokens: 200, totalRequests: 2, duplicatesRemoved: 0 });
  });

  it("counts duplicate paths and symlinks only once", async () => {
    const main = path.dirname(path.dirname(mocks.dataFile));
    const alias = path.join(root, "alias");
    symlinkSync(main, alias);
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", `${main},${main},${alias}`);
    expect(await summarize()).toMatchObject({ sourceCount: 1, totalTokens: 100 });
  });

  it("uses VN midnight and seven calendar days, excluding future usage", async () => {
    const peer = database("peer", [key()], [
      request({ id: 2, timestamp: "2026-11-04T16:59:59.999Z" }),
      request({ id: 3, timestamp: "2026-10-29T17:00:00.000Z" }),
      request({ id: 4, timestamp: "2026-10-29T16:59:59.999Z" }),
      request({ id: 5, timestamp: "2026-11-05T06:00:00.001Z" }),
      request({ id: 6, timestamp: now.toISOString() }),
    ]);
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", peer);
    expect(await summarize()).toMatchObject({ totalTokens: 200, windowStart: today });
    expect(await summarize("7d")).toMatchObject({
      totalTokens: 400, windowStart: "2026-10-29T17:00:00.000Z", period: "7D",
    });
  });

  it("supports legacy JSON token counts", async () => {
    const peer = database("peer", [key()], [
      request({ promptTokens: null, completionTokens: null, tokens: '{"input_tokens":40,"output_tokens":10}' }),
    ]);
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", peer);
    expect(await summarize()).toMatchObject({ totalTokens: 150, totalRequests: 2 });
  });

  it("returns partial data when a peer is missing or has an incompatible schema", async () => {
    const invalid = database("invalid");
    const db = new DatabaseSync(path.join(invalid, "db/data.sqlite"));
    db.exec("DROP TABLE usageHistory");
    db.close();
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", `${path.join(root, "missing")},${invalid}`);
    expect(await summarize()).toMatchObject({ sourceCount: 1, unavailableSources: 2, totalTokens: 100 });
  });

  it("fails clearly if no source can be read", async () => {
    mocks.dataFile = path.join(root, "missing-main/db/data.sqlite");
    vi.stubEnv("TELEGRAM_REPORT_DATA_DIRS", path.join(root, "missing-peer"));
    await expect(summarize()).rejects.toThrow("Telegram report usage sources unavailable");
  });
});

// Compare new SQLite-backed DB layer vs legacy lowdb behavior.
// Verifies: same public API signatures + equivalent results for core operations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let sqliteDb;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-compare-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB SQLite layer — public API parity", () => {
  it("settings: get → defaults; update → merge", async () => {
    const s = await sqliteDb.getSettings();
    expect(s).toBeDefined();
    expect(s.cloudEnabled).toBe(false);
    expect(s.requireLogin).toBe(true);

    const updated = await sqliteDb.updateSettings({ cloudEnabled: true, customField: "x" });
    expect(updated.cloudEnabled).toBe(true);
    expect(updated.customField).toBe("x");
    expect(updated.requireLogin).toBe(true); // default preserved

    const re = await sqliteDb.getSettings();
    expect(re.cloudEnabled).toBe(true);
    expect(re.customField).toBe("x");
  });

  it("isCloudEnabled reflects settings", async () => {
    await sqliteDb.updateSettings({ cloudEnabled: true });
    expect(await sqliteDb.isCloudEnabled()).toBe(true);
    await sqliteDb.updateSettings({ cloudEnabled: false });
    expect(await sqliteDb.isCloudEnabled()).toBe(false);
  });

  it("apiKeys: create/get/validate/delete", async () => {
    const k = await sqliteDb.createApiKey("test-key", "machine-abc");
    expect(k.id).toBeDefined();
    expect(k.key).toMatch(/^sk-/);
    expect(k.machineId).toBe("machine-abc");
    expect(k.isActive).toBe(true);
    expect(k.source).toBe("manual");
    expect(k.scheduleMode).toBe("none");
    expect(k.forcedModel).toBeNull();

    const all = await sqliteDb.getApiKeys();
    expect(all.find((x) => x.id === k.id)).toBeDefined();

    expect(await sqliteDb.validateApiKey(k.key)).toBeTruthy();
    expect(await sqliteDb.resolveValidatedApiKey(k.key)).toMatchObject({ id: k.id, forcedModel: null });
    expect(await sqliteDb.validateApiKey("invalid")).toBeFalsy();

    const deleted = await sqliteDb.deleteApiKey(k.id);
    expect(deleted).toBe(true);
    expect(await sqliteDb.getApiKeyById(k.id)).toBeNull();
  });

  it("apiKeys: forced model persists through update and export/import", async () => {
    const key = await sqliteDb.createApiKey("forced-model-key", "machine-xyz");
    const updated = await sqliteDb.updateApiKey(key.id, { forcedModel: "openai/gpt-5.4-mini" });
    expect(updated.forcedModel).toBe("openai/gpt-5.4-mini");

    const byId = await sqliteDb.getApiKeyById(key.id);
    expect(byId.forcedModel).toBe("openai/gpt-5.4-mini");

    const validated = await sqliteDb.resolveValidatedApiKey(key.key);
    expect(validated.forcedModel).toBe("openai/gpt-5.4-mini");

    const exported = await sqliteDb.exportDb();
    const exportedKey = exported.apiKeys.find((item) => item.id === key.id);
    expect(exportedKey.forcedModel).toBe("openai/gpt-5.4-mini");
  });

  it("apiKeys: telegram keys reuse by telegramUserId and obey schedule/manual pause", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-22T01:30:00.000Z"));

      const first = await sqliteDb.upsertTelegramApiKey({
        telegramUserId: "42",
        username: "alice",
        machineId: "machine-abc",
      });
      expect(first.source).toBe("telegram");
      expect(first.scheduleMode).toBe("vn-business-hours");
      expect(first.isActive).toBe(true);

      const second = await sqliteDb.upsertTelegramApiKey({
        telegramUserId: "42",
        username: "alice-renamed",
        machineId: "machine-abc",
      });
      expect(second.id).toBe(first.id);
      expect(second.key).toBe(first.key);
      expect(second.name).toBe("alice-renamed");

      const paused = await sqliteDb.updateApiKey(first.id, { isActive: false });
      expect(paused.isActive).toBe(false);
      expect(paused.manualDisabled).toBe(true);

      const resumed = await sqliteDb.updateApiKey(first.id, { isActive: true });
      expect(resumed.isActive).toBe(true);
      expect(resumed.manualDisabled).toBe(false);

      vi.setSystemTime(new Date("2026-05-22T12:30:00.000Z"));
      const reconcile = await sqliteDb.reconcileTelegramApiKeySchedule();
      expect(reconcile.total).toBeGreaterThanOrEqual(1);
      expect(await sqliteDb.validateApiKey(first.key)).toBe(false);

      const reloaded = await sqliteDb.getApiKeyById(first.id);
      expect(reloaded.isActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("providerConnections: CRUD + reorder by priority", async () => {
    const c1 = await sqliteDb.createProviderConnection({ provider: "test", authType: "apikey", name: "a", apiKey: "k1" });
    const c2 = await sqliteDb.createProviderConnection({ provider: "test", authType: "apikey", name: "b", apiKey: "k2" });
    const c3 = await sqliteDb.createProviderConnection({ provider: "test", authType: "apikey", name: "c", apiKey: "k3" });

    const list = await sqliteDb.getProviderConnections({ provider: "test" });
    expect(list).toHaveLength(3);
    expect(list[0].priority).toBe(1);
    expect(list[1].priority).toBe(2);
    expect(list[2].priority).toBe(3);

    // Update priority and reorder
    await sqliteDb.updateProviderConnection(c3.id, { priority: 1 });
    const reordered = await sqliteDb.getProviderConnections({ provider: "test" });
    expect(reordered[0].name).toBe("c");

    // Delete reorders remaining
    await sqliteDb.deleteProviderConnection(c1.id);
    const after = await sqliteDb.getProviderConnections({ provider: "test" });
    expect(after).toHaveLength(2);
    expect(after.every((c) => [1, 2].includes(c.priority))).toBe(true);
  });

  it("providerConnections: optional fields persisted via JSON column", async () => {
    const c = await sqliteDb.createProviderConnection({
      provider: "p2", authType: "oauth", email: "x@y.com",
      accessToken: "tok", refreshToken: "rtok", expiresAt: 12345,
      providerSpecificData: { foo: "bar" },
    });
    const back = await sqliteDb.getProviderConnectionById(c.id);
    expect(back.accessToken).toBe("tok");
    expect(back.refreshToken).toBe("rtok");
    expect(back.expiresAt).toBe(12345);
    expect(back.providerSpecificData).toEqual({ foo: "bar" });
  });

  it("providerConnections: successful validation clears stale routing locks", async () => {
    const c = await sqliteDb.createProviderConnection({
      provider: "health-reset-update",
      authType: "oauth",
      email: "update@example.com",
      accessToken: "old-token",
    });
    await sqliteDb.updateProviderConnection(c.id, {
      testStatus: "unavailable",
      lastError: "Access denied",
      lastErrorAt: "2026-09-05T00:00:00.000Z",
      errorCode: 403,
      backoffLevel: 3,
      rateLimitedUntil: "2099-01-01T00:00:00.000Z",
      modelLock_modelA: "2099-01-01T00:00:00.000Z",
      modelLock_modelB: "2099-01-01T00:00:00.000Z",
    });

    await sqliteDb.updateProviderConnection(c.id, { testStatus: "active" });

    const back = await sqliteDb.getProviderConnectionById(c.id);
    expect(back).toMatchObject({
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      backoffLevel: 0,
      rateLimitedUntil: null,
      modelLock_modelA: null,
      modelLock_modelB: null,
    });
  });

  it("providerConnections: re-saving valid OAuth credentials clears stale routing locks", async () => {
    const existing = await sqliteDb.createProviderConnection({
      provider: "health-reset-resave",
      authType: "oauth",
      email: "resave@example.com",
      accessToken: "old-token",
    });
    await sqliteDb.updateProviderConnection(existing.id, {
      testStatus: "unavailable",
      lastError: "Access denied",
      errorCode: 403,
      backoffLevel: 2,
      modelLock_modelA: "2099-01-01T00:00:00.000Z",
    });

    const resaved = await sqliteDb.createProviderConnection({
      provider: "health-reset-resave",
      authType: "oauth",
      email: "resave@example.com",
      accessToken: "new-token",
      testStatus: "active",
    });

    expect(resaved.id).toBe(existing.id);
    const back = await sqliteDb.getProviderConnectionById(existing.id);
    expect(back).toMatchObject({
      accessToken: "new-token",
      testStatus: "active",
      lastError: null,
      errorCode: null,
      backoffLevel: 0,
      modelLock_modelA: null,
    });
  });

  it("providerConnections: active soft warnings survive the health reset", async () => {
    const c = await sqliteDb.createProviderConnection({
      provider: "health-reset-warning",
      authType: "oauth",
      email: "warning@example.com",
    });
    await sqliteDb.updateProviderConnection(c.id, {
      testStatus: "unavailable",
      lastError: "Old failure",
      modelLock_modelA: "2099-01-01T00:00:00.000Z",
    });

    const warningAt = "2026-09-06T00:00:00.000Z";
    await sqliteDb.updateProviderConnection(c.id, {
      testStatus: "active",
      lastError: "Connected, but credits are exhausted",
      lastErrorAt: warningAt,
    });

    const back = await sqliteDb.getProviderConnectionById(c.id);
    expect(back).toMatchObject({
      testStatus: "active",
      lastError: "Connected, but credits are exhausted",
      lastErrorAt: warningAt,
      errorCode: null,
      backoffLevel: 0,
      modelLock_modelA: null,
    });
  });

  it("providerConnections: GitHub OAuth uses account identity as fallback name", async () => {
    const c = await sqliteDb.createProviderConnection({
      provider: "github",
      authType: "oauth",
      accessToken: "tok",
      providerSpecificData: { githubLogin: "octocat" },
    });

    expect(c.name).toBe("octocat");
    const back = await sqliteDb.getProviderConnectionById(c.id);
    expect(back.name).toBe("octocat");
  });

  it("providerNodes: CRUD", async () => {
    const n = await sqliteDb.createProviderNode({ type: "openai", name: "Test", baseUrl: "https://api.test", apiType: "openai" });
    expect(n.id).toBeDefined();
    expect(n.baseUrl).toBe("https://api.test");

    const all = await sqliteDb.getProviderNodes({ type: "openai" });
    expect(all.find((x) => x.id === n.id)).toBeDefined();

    await sqliteDb.updateProviderNode(n.id, { name: "Test2" });
    const updated = await sqliteDb.getProviderNodeById(n.id);
    expect(updated.name).toBe("Test2");

    await sqliteDb.deleteProviderNode(n.id);
    expect(await sqliteDb.getProviderNodeById(n.id)).toBeNull();
  });

  it("proxyPools: CRUD with sort by updatedAt desc", async () => {
    const p1 = await sqliteDb.createProxyPool({ name: "p1", proxyUrl: "http://a", type: "http" });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = await sqliteDb.createProxyPool({ name: "p2", proxyUrl: "http://b", type: "http" });
    const list = await sqliteDb.getProxyPools();
    expect(list[0].id).toBe(p2.id); // newest first
    await sqliteDb.deleteProxyPool(p1.id);
    await sqliteDb.deleteProxyPool(p2.id);
  });

  it("combos: CRUD", async () => {
    const c = await sqliteDb.createCombo({ name: "combo1", models: ["m1", "m2"], kind: "fallback" });
    expect(c.id).toBeDefined();
    expect(c.models).toEqual(["m1", "m2"]);
    const byName = await sqliteDb.getComboByName("combo1");
    expect(byName.id).toBe(c.id);
    await sqliteDb.updateCombo(c.id, { models: ["m3"] });
    const updated = await sqliteDb.getComboById(c.id);
    expect(updated.models).toEqual(["m3"]);
    expect(await sqliteDb.deleteCombo(c.id)).toBe(true);
  });

  it("modelAliases: KV ops", async () => {
    await sqliteDb.setModelAlias("alias1", "real-model-1");
    await sqliteDb.setModelAlias("alias2", "real-model-2");
    const all = await sqliteDb.getModelAliases();
    expect(all.alias1).toBe("real-model-1");
    expect(all.alias2).toBe("real-model-2");
    await sqliteDb.deleteModelAlias("alias1");
    expect((await sqliteDb.getModelAliases()).alias1).toBeUndefined();
  });

  it("customModels: add/list/delete with dedupe", async () => {
    const ok1 = await sqliteDb.addCustomModel({ providerAlias: "p1", id: "m1", type: "llm", name: "Model 1" });
    const dup = await sqliteDb.addCustomModel({ providerAlias: "p1", id: "m1", type: "llm" });
    expect(ok1).toBe(true);
    expect(dup).toBe(false);
    const list = await sqliteDb.getCustomModels();
    expect(list.find((m) => m.id === "m1")).toBeDefined();
    await sqliteDb.deleteCustomModel({ providerAlias: "p1", id: "m1" });
    const after = await sqliteDb.getCustomModels();
    expect(after.find((m) => m.id === "m1")).toBeUndefined();
  });

  it("mitmAlias: get/set per tool", async () => {
    await sqliteDb.setMitmAliasAll("cursor", { "gpt-5": "claude-3" });
    const a = await sqliteDb.getMitmAlias("cursor");
    expect(a["gpt-5"]).toBe("claude-3");
    const all = await sqliteDb.getMitmAlias();
    expect(all.cursor).toEqual({ "gpt-5": "claude-3" });
  });

  it("disabledModels: add/remove per provider", async () => {
    await sqliteDb.disableModels("openai", ["gpt-3", "gpt-4"]);
    expect(await sqliteDb.getDisabledByProvider("openai")).toEqual(expect.arrayContaining(["gpt-3", "gpt-4"]));
    await sqliteDb.enableModels("openai", ["gpt-3"]);
    expect(await sqliteDb.getDisabledByProvider("openai")).toEqual(["gpt-4"]);
    await sqliteDb.enableModels("openai", []);
    expect(await sqliteDb.getDisabledByProvider("openai")).toEqual([]);
  });

  it("usage: saveRequestUsage + getUsageHistory + getUsageStats", async () => {
    await sqliteDb.saveRequestUsage({
      provider: "openai", model: "gpt-4", connectionId: "c1",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      endpoint: "/v1/chat/completions", status: "ok",
    });
    await sqliteDb.saveRequestUsage({
      provider: "openai", model: "gpt-4", connectionId: "c1",
      tokens: { prompt_tokens: 200, completion_tokens: 100 },
      endpoint: "/v1/chat/completions", status: "ok",
    });

    const hist = await sqliteDb.getUsageHistory({ provider: "openai" });
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[0].tokens.prompt_tokens).toBeDefined();

    const stats = await sqliteDb.getUsageStats("24h");
    expect(stats.totalRequests).toBeGreaterThanOrEqual(2);
    expect(stats.byProvider.openai).toBeDefined();
    expect(stats.byProvider.openai.requests).toBeGreaterThanOrEqual(2);
    expect(stats.byProvider.openai.promptTokens).toBeGreaterThanOrEqual(300);
  });

  it("usage: keeps API keys with the same masked prefix in separate groups", async () => {
    const keyA = await sqliteDb.createApiKey("same-prefix-a", "shared-machine-id");
    const keyB = await sqliteDb.createApiKey("same-prefix-b", "shared-machine-id");

    expect(keyA.key.slice(0, 8)).toBe(keyB.key.slice(0, 8));

    await sqliteDb.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      apiKey: keyA.key,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      status: "ok",
    });
    await sqliteDb.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      apiKey: keyB.key,
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
      status: "ok",
    });

    const stats = await sqliteDb.getUsageStats("24h");
    const names = Object.values(stats.byApiKey).map((item) => item.keyName);

    expect(names).toContain("same-prefix-a");
    expect(names).toContain("same-prefix-b");
    expect(Object.keys(stats.byApiKey).join("|")).not.toContain(keyA.key);
    expect(Object.keys(stats.byApiKey).join("|")).not.toContain(keyB.key);
  });

  it("usage: telegram usage summary respects Vietnam day windows and excludes manual keys", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-05-22T03:00:00.000Z");
      vi.setSystemTime(now);

      const manualKey = await sqliteDb.createApiKey("manual", "machine-manual");
      const telegramA = await sqliteDb.upsertTelegramApiKey({
        telegramUserId: "100",
        username: "alice",
        machineId: "machine-abc",
        now,
      });
      const telegramB = await sqliteDb.upsertTelegramApiKey({
        telegramUserId: "101",
        username: "bob",
        machineId: "machine-def",
        now,
      });

      await sqliteDb.saveRequestUsage({
        timestamp: "2026-05-18T03:00:00.000Z",
        provider: "openai",
        model: "gpt-4",
        apiKey: telegramA.key,
        tokens: { prompt_tokens: 50, completion_tokens: 50 },
        status: "ok",
      });
      await sqliteDb.saveRequestUsage({
        timestamp: "2026-05-21T16:59:59.000Z",
        provider: "openai",
        model: "gpt-4",
        apiKey: telegramA.key,
        tokens: { prompt_tokens: 999, completion_tokens: 1 },
        status: "ok",
      });
      await sqliteDb.saveRequestUsage({
        timestamp: "2026-05-21T17:00:00.000Z",
        provider: "openai",
        model: "gpt-4",
        apiKey: telegramA.key,
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        status: "ok",
      });
      await sqliteDb.saveRequestUsage({
        timestamp: "2026-05-22T02:00:00.000Z",
        provider: "openai",
        model: "gpt-4",
        apiKey: telegramB.key,
        tokens: { prompt_tokens: 200, completion_tokens: 100 },
        status: "ok",
      });
      await sqliteDb.saveRequestUsage({
        timestamp: "2026-05-22T02:10:00.000Z",
        provider: "openai",
        model: "gpt-4",
        apiKey: manualKey.key,
        tokens: { prompt_tokens: 500, completion_tokens: 500 },
        status: "ok",
      });
      await sqliteDb.saveRequestUsage({
        timestamp: "2026-05-22T02:20:00.000Z",
        provider: "openai",
        model: "gpt-4",
        tokens: { prompt_tokens: 500, completion_tokens: 500 },
        status: "ok",
      });

      const todaySummary = await sqliteDb.getTelegramUsageShareSummary("today", now);
      expect(todaySummary.totalTokens).toBe(450);
      expect(todaySummary.totalCost).toBeGreaterThanOrEqual(0);
      expect(todaySummary.keysWithUsage).toBe(2);
      expect(todaySummary.items[0].name).toBe("bob");
      expect(todaySummary.items[0].totalTokens).toBe(300);
      expect(todaySummary.items[1].name).toBe("alice");
      expect(todaySummary.items[1].totalTokens).toBe(150);

      const weekSummary = await sqliteDb.getTelegramUsageShareSummary("7d", now);
      expect(weekSummary.totalTokens).toBe(1550);
      expect(weekSummary.keysWithUsage).toBe(2);
      expect(weekSummary.items[0].name).toBe("alice");
      expect(weekSummary.items[0].totalTokens).toBe(1250);
      expect(weekSummary.items[1].name).toBe("bob");
    } finally {
      vi.useRealTimers();
    }
  });

  it("usage: pending tracking in-memory", () => {
    sqliteDb.trackPendingRequest("gpt-4", "openai", "c1", true);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);
    sqliteDb.trackPendingRequest("gpt-4", "openai", "c1", false);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
  });

  it("requestDetails: save → query with paging", async () => {
    // Enable observability first
    await sqliteDb.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

    await sqliteDb.saveRequestDetail({
      id: "d1", provider: "openai", model: "gpt-4", connectionId: "c1",
      status: "ok", tokens: { prompt_tokens: 10 },
      request: { method: "POST" }, response: { status: 200 },
    });

    // Wait for buffer flush
    await new Promise((r) => setTimeout(r, 200));

    const got = await sqliteDb.getRequestDetailById("d1");
    expect(got).toBeDefined();
    expect(got.id).toBe("d1");

    const list = await sqliteDb.getRequestDetails({ provider: "openai" });
    expect(list.details.length).toBeGreaterThanOrEqual(1);
    expect(list.pagination.totalItems).toBeGreaterThanOrEqual(1);
  });

  it("exportDb / importDb roundtrip", async () => {
    const exported = await sqliteDb.exportDb();
    expect(exported.settings).toBeDefined();
    expect(Array.isArray(exported.providerConnections)).toBe(true);
    expect(typeof exported.modelAliases).toBe("object");

    // Add marker, export, import a different payload, verify reset
    await sqliteDb.setModelAlias("marker", "before");
    const snap = await sqliteDb.exportDb();

    await sqliteDb.setModelAlias("marker", "after");
    expect((await sqliteDb.getModelAliases()).marker).toBe("after");

    await sqliteDb.importDb(snap);
    expect((await sqliteDb.getModelAliases()).marker).toBe("before");
  });

  it("pricing: user pricing merged with constants", async () => {
    await sqliteDb.updatePricing({ openai: { "gpt-test": { input: 1, output: 2 } } });
    const p = await sqliteDb.getPricing();
    expect(p.openai["gpt-test"]).toEqual({ input: 1, output: 2 });

    const single = await sqliteDb.getPricingForModel("openai", "gpt-test");
    expect(single).toEqual({ input: 1, output: 2 });

    await sqliteDb.resetPricing("openai", "gpt-test");
    expect((await sqliteDb.getPricing()).openai?.["gpt-test"]).toBeUndefined();
  });

  it("getChartData: 24h buckets", async () => {
    const data = await sqliteDb.getChartData("24h");
    expect(data).toHaveLength(24);
    expect(data[0]).toHaveProperty("label");
    expect(data[0]).toHaveProperty("tokens");
    expect(data[0]).toHaveProperty("cost");
  });

  it("getChartData: 7d buckets", async () => {
    const data = await sqliteDb.getChartData("7d");
    expect(data).toHaveLength(7);
  });
});
